import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { KubeContentType, KubeResourceCatalog, type KubeApiClient, type KubeTypeRef } from '@pragmatic-tech-ai/pragmatic-kube'
import { ComponentConfigurationMounts, ConsoleFingerprintKeys, EnvironmentHiveDatabase, HiveBackend, InfraMode, K8sManifestBuilder, TenantOwner, type TenantDirectorySeed } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import type { BootstrapSettings } from './bootstrap-settings.js'
import { EngineSecretOrigin, EngineSecretScope, EngineSecretSet, type EngineSecretSpec } from './engine-secret-set.js'
import type { ITlsMinter, TlsMaterial } from './tls-minter.js'
import { RealmSecretsDatabase } from '../environments/realm-secrets-database.js'

/** Random bytes for every minted value (crypto.randomBytes in the Job; a fixed source in tests). */
export interface IRandomSource
{
    Bytes(count: number): Buffer
}

export class CryptoRandomSource implements IRandomSource
{
    public Bytes(count: number): Buffer
    {
        return randomBytes(count)
    }
}

/** What one run did, by `<namespace>/<name>`: never a value. */
export type EngineBootstrapReport = {
    readonly Created: readonly string[]
    readonly Kept: readonly string[]
    readonly Refreshed: readonly string[]
}

type SecretBody = { type?: string; data?: Record<string, string> }
type SecretData = Record<string, Buffer | string>

/**
 * The engine chart's bootstrap (pre-install / pre-upgrade hook Job, the console image): creates the realm sign-in service's
 * namespace when absent, then every engine Secret (EngineSecretSet) that is absent, with fresh random material minted in
 * the cluster, so the install command and the chart values stay secret-free and the platform never sees a hive secret.
 * An existing minted Secret is never read for replacement nor written: a create that finds one counts it kept, so a
 * `helm upgrade` over a running engine changes nothing. Copies (the IdP's admin token and database URL, its CA for the
 * console, the console certificate for the IdP Ingress) are refreshed from their source each run.
 */
export class EngineBootstrap
{
    public static readonly FieldManager = 'pragmatic-engine-bootstrap'
    private static readonly SecretType: KubeTypeRef = { apiVersion: 'v1', kind: 'Secret' }
    private static readonly NamespaceType: KubeTypeRef = KubeResourceCatalog.NamespaceType
    private static readonly PasswordBytes = 24
    private static readonly OwnerPasswordBytes = 18
    private static readonly KeyBytes = 32
    private static readonly TokenBytes = 32
    private static readonly TextEncoding = 'base64url'
    private static readonly Base64 = 'base64'
    private static readonly Utf8 = 'utf8'
    private static readonly RsaType = 'rsa'
    private static readonly RsaModulus = 2048
    private static readonly Pkcs8 = 'pkcs8'
    private static readonly Pem = 'pem'
    private static readonly NamespaceSeparator = '/'
    private static readonly SuperuserRole = 'postgres'
    private static readonly SuperuserDatabase = 'postgres'
    /** The roles and databases of the hive Postgres' applications file (the chart's pragmatic-postgres-applications). */
    public static readonly TenantAdminDatabase = 'tenant_admin'
    public static readonly TenantIdpDatabase = 'tenant_idp'
    private static readonly WildcardPrefix = '*.'
    private static readonly ApiVersionKey = 'apiVersion'
    private static readonly KindKey = 'kind'
    private static readonly MetadataKey = 'metadata'
    private static readonly NameKey = 'name'
    private static readonly NamespaceKey = 'namespace'
    private static readonly LabelsKey = 'labels'
    private static readonly AnnotationsKey = 'annotations'
    private static readonly TypeKey = 'type'
    private static readonly DataKey = 'data'
    private static readonly SecretKind = 'Secret'
    private static readonly NamespaceKind = 'Namespace'
    /** Pod Security admission (Kubernetes ≥ 1.25): the level every pod of an engine namespace must meet. */
    public static readonly PodSecurityEnforceLabel = 'pod-security.kubernetes.io/enforce'
    public static readonly PodSecurityLevel = 'restricted'
    public static readonly PodSecurityVersionLabel = 'pod-security.kubernetes.io/enforce-version'
    public static readonly PodSecurityVersion = 'latest'

    /** The engine namespaces' Pod Security labels (environments get `baseline` from the tenant plane, likewise at `latest`). */
    public static PodSecurityLabels(): Record<string, string>
    {
        const B = EngineBootstrap
        return { [B.PodSecurityEnforceLabel]: B.PodSecurityLevel, [B.PodSecurityVersionLabel]: B.PodSecurityVersion }
    }
    private static readonly MissingSourcePrefix = 'the bootstrap cannot copy a Secret whose source is absent: '
    private static readonly UnknownSecretPrefix = 'the bootstrap has no material for the Secret '
    private static readonly OtherEnginePrefix = 'this cluster already holds the engine of '
    private static readonly OtherEngineInfix = ' (its kept seed); the install names '
    private static readonly OtherEngineSuffix = '. A kept engine keeps its tenant and hive ids: install with those, or remove the kept engine first (runbook: customer-cluster.md).'
    private static readonly IdSeparator = ', hive '
    private static readonly TenantWord = 'tenant '
    private static readonly ConfigMapType: KubeTypeRef = { apiVersion: 'v1', kind: 'ConfigMap' }
    private static readonly ConfigMapKind = 'ConfigMap'
    /** The components the console configures in the engine's namespace (the agent only when one runs), and the realm sign-in service in its own. */
    public static readonly ConnectedComponents: readonly string[] = [ReleaseApp.TenantAdmin, ReleaseApp.HiveAgent]
    public static readonly StandaloneComponents: readonly string[] = [ReleaseApp.TenantAdmin]
    public static readonly IdpComponents: readonly string[] = [ReleaseApp.TenantIdp]

    public constructor(
        private readonly kube: KubeApiClient,
        private readonly settings: BootstrapSettings,
        private readonly tls: ITlsMinter,
        private readonly random: IRandomSource = new CryptoRandomSource(),
        private readonly clock: () => Date = () => new Date())
    {
    }

    /**
     * The first hook step (`bootstrap namespace`): the realm sign-in service's namespace, created when absent, so the
     * chart's namespaced bootstrap Roles can be bound in it before the Secrets are minted. Both engine namespaces then
     * carry the Pod Security `restricted` enforce label (every engine workload runs restricted-compliant: non-root,
     * no privilege escalation, every capability dropped, RuntimeDefault seccomp, no host paths); `pragmatic-system`,
     * which `helm --create-namespace` created unlabelled, is labelled here, and a label already right is left alone.
     */
    public async RunNamespace(): Promise<EngineBootstrapReport>
    {
        const s = this.settings
        const created = await this.EnsureNamespace(s.IdpNamespace)
        const refreshed: string[] = []
        for (const namespace of [s.Namespace, s.IdpNamespace])
        {
            if (await this.EnsurePodSecurity(namespace))
            {
                refreshed.push(namespace)
            }
        }
        return { Created: created ? [s.IdpNamespace] : [], Kept: created ? [] : [s.IdpNamespace], Refreshed: refreshed }
    }

    /** The namespace's Pod Security enforce label set to `restricted` when it is not; true when it was changed. */
    private async EnsurePodSecurity(name: string): Promise<boolean>
    {
        const B = EngineBootstrap
        const path = KubeResourceCatalog.PathOf(B.NamespaceType, undefined, name)
        const found = await this.kube.Get(path) as { metadata?: { labels?: Record<string, string> } } | undefined
        if (found === undefined)
        {
            // helm creates the release namespace before any hook runs; one that is absent is not this step's to make.
            return false
        }
        const labels = found.metadata?.labels ?? {}
        if (labels[B.PodSecurityEnforceLabel] === B.PodSecurityLevel && labels[B.PodSecurityVersionLabel] === B.PodSecurityVersion)
        {
            return false
        }
        await this.kube.Patch(path, { [B.MetadataKey]: { [B.LabelsKey]: B.PodSecurityLabels() } }, KubeContentType.MergePatch)
        return true
    }

    public async Run(): Promise<EngineBootstrapReport>
    {
        const B = EngineBootstrap
        const S = EngineSecretSet
        const s = this.settings
        const report = { Created: [] as string[], Kept: [] as string[], Refreshed: [] as string[] }
        await this.RefuseAnotherEngine()
        await this.EnsureNamespace(s.IdpNamespace)
        // The empty configuration objects the console writes each component's applied configuration into: created when
        // absent and otherwise never touched (not chart-owned, so an upgrade never drops what the console wrote).
        const engineComponents = s.Standalone ? B.StandaloneComponents : B.ConnectedComponents
        for (const [namespace, components] of [[s.Namespace, engineComponents], [s.IdpNamespace, B.IdpComponents]] as const)
        {
            for (const component of components)
            {
                await this.EnsureConfigurationObjects(namespace, component, report)
            }
        }
        for (const spec of S.Specs(s.SelfSigned, s.TlsSecret))
        {
            const namespace = this.NamespaceOf(spec)
            const key = namespace + B.NamespaceSeparator + spec.Name
            if (spec.Origin === EngineSecretOrigin.Copied)
            {
                await this.Apply(namespace, spec, await this.CopyOf(spec))
                report.Refreshed.push(key)
                continue
            }
            if (spec.Name === S.DevCa)
            {
                // The development CA follows the console certificate it signed (written with it, below).
                continue
            }
            const created = await this.CreateMinted(namespace, spec)
            ;(created ? report.Created : report.Kept).push(key)
        }
        return report
    }

    /**
     * A kept engine keeps its ids: its seed names the tenant (the realm id) and hive its sealed data belongs to, and a new
     * tenant's sign-in service would mint new keys over a database sealed with the old ones. Refused before anything is
     * written, naming both.
     */
    private async RefuseAnotherEngine(): Promise<void>
    {
        const B = EngineBootstrap
        const s = this.settings
        const kept = await this.kube.Get(this.SecretPath(s.Namespace, EngineSecretSet.TenantAdminSeed)) as SecretBody | undefined
        const encoded = kept?.data?.[EngineSecretSet.SeedKey]
        if (encoded === undefined)
        {
            return
        }
        const seed = JSON.parse(Buffer.from(encoded, B.Base64).toString(B.Utf8)) as { tenant?: { id?: unknown }; hives?: Array<{ id?: unknown }> }
        const tenant = String(seed.tenant?.id)
        const hive = String(seed.hives?.[0]?.id)
        if (tenant !== s.TenantId || hive !== s.HiveId)
        {
            throw new Error(B.OtherEnginePrefix + B.TenantWord + tenant + B.IdSeparator + hive + B.OtherEngineInfix + B.TenantWord + s.TenantId + B.IdSeparator + s.HiveId + B.OtherEngineSuffix)
        }
    }

    /** Creates a minted Secret when absent (looked up first, so nothing is minted for a kept one); false (kept, untouched) when one exists. */
    private async CreateMinted(namespace: string, spec: EngineSecretSpec): Promise<boolean>
    {
        const S = EngineSecretSet
        if (spec.Name === S.ConsoleTls)
        {
            return await this.CreateConsoleTls(namespace, spec)
        }
        if (await this.kube.Get(this.SecretPath(namespace, spec.Name)) !== undefined)
        {
            return false
        }
        return await this.kube.Create(this.CollectionPath(namespace), this.SecretOf(namespace, spec, this.Mint(spec)))
    }

    /**
     * The self-signed console certificate (console, sign-in service and every environment of the base domain) and its CA,
     * kept only as a pair: when either is missing (a crash between the two writes) both are minted again, the CA first, then
     * the certificate, so the CA Secret always names the issuer of the certificate it sits beside.
     */
    private async CreateConsoleTls(namespace: string, spec: EngineSecretSpec): Promise<boolean>
    {
        const S = EngineSecretSet
        const B = EngineBootstrap
        const s = this.settings
        const certificate = await this.kube.Get(this.SecretPath(namespace, spec.Name))
        const ca = await this.kube.Get(this.SecretPath(namespace, S.DevCa))
        if (certificate !== undefined && ca !== undefined)
        {
            return false
        }
        const material = this.tls.Mint([s.ConsoleHost, s.IdpHost, B.WildcardPrefix + s.BaseDomain])
        const caSpec: EngineSecretSpec = { Name: S.DevCa, Scope: EngineSecretScope.Engine, Keys: [S.CaKey], Type: S.OpaqueType, Origin: EngineSecretOrigin.Minted }
        const caKeySpec: EngineSecretSpec = { Name: S.DevCaKey, Scope: EngineSecretScope.Engine, Keys: [S.CaKeyKey], Type: S.OpaqueType, Origin: EngineSecretOrigin.Minted }
        // The key first: a CA Secret never names an issuer whose key was lost.
        await this.Apply(namespace, caKeySpec, { [S.CaKeyKey]: material.CaKey })
        await this.Apply(namespace, caSpec, { [S.CaKey]: material.Ca })
        await this.Apply(namespace, spec, { [S.TlsCertKey]: material.Cert, [S.TlsKeyKey]: material.Key })
        return true
    }

    /** Fresh material for one minted Secret. */
    private Mint(spec: EngineSecretSpec): SecretData
    {
        const S = EngineSecretSet
        const B = EngineBootstrap
        const s = this.settings
        switch (spec.Name)
        {
            case S.PostgresSuperuser:
                return this.DatabaseSecret(B.SuperuserRole, B.SuperuserDatabase)
            case S.PostgresTenantAdmin:
                return this.DatabaseSecret(B.TenantAdminDatabase, B.TenantAdminDatabase)
            case S.PostgresTenantIdp:
                return this.DatabaseSecret(B.TenantIdpDatabase, B.TenantIdpDatabase)
            case S.PostgresRealmSecretsConsole:
                return this.DatabaseSecret(RealmSecretsDatabase.ConsoleRole, RealmSecretsDatabase.Database)
            case S.PostgresRealmSecretsIdp:
                return this.DatabaseSecret(RealmSecretsDatabase.IdpRole, RealmSecretsDatabase.Database)
            case S.PostgresRealmSecretsEnvironments:
                return this.DatabaseSecret(RealmSecretsDatabase.EnvironmentsRole, RealmSecretsDatabase.Database)
            case S.TenantAdminMasterKey:
            case S.IdpMasterKey:
            case S.RealmMasterKey:
                return { [S.MasterKeyKey]: this.random.Bytes(B.KeyBytes) }
            case S.TenantAdminFingerprint:
                return { [S.FingerprintKeyKey]: this.random.Bytes(ConsoleFingerprintKeys.KeyBytes) }
            case S.TenantAdminSeed:
                return { [S.SeedKey]: JSON.stringify(this.Seed()) }
            case S.IdpAdminToken:
                return { [S.AdminTokenKey]: this.Text(B.TokenBytes) }
            case S.OwnerInitial:
                return { [S.EmailKey]: s.OwnerEmail, [S.PasswordKey]: this.Text(B.OwnerPasswordBytes) }
            case S.IdpSigningKey:
                return { [S.SigningKeyKey]: B.SigningKeyPem() }
            case S.IdpTls:
                return B.IdpTlsData(this.tls.Mint([s.IdpInternalHost, s.IdpHost]))
            default:
                throw new Error(B.UnknownSecretPrefix + spec.Name)
        }
    }

    /** A copy's data, read from its source Secret (absent source: the run fails naming it, never a value). */
    private async CopyOf(spec: EngineSecretSpec): Promise<SecretData>
    {
        const S = EngineSecretSet
        const B = EngineBootstrap
        const s = this.settings
        switch (spec.Name)
        {
            case S.IdpCa:
                return { [S.CaKey]: await this.SourceKey(s.IdpNamespace, S.IdpTls, S.CaKey) }
            case S.IdpAdminToken:
                return { [S.AdminTokenKey]: await this.SourceKey(s.Namespace, S.IdpAdminToken, S.AdminTokenKey) }
            case S.IdpDatabase:
                return { [S.DatabaseUrlKey]: await this.SourceKey(s.Namespace, S.PostgresTenantIdp, S.DatabaseUrlKey) }
            case S.RealmMasterKey:
                return { [S.MasterKeyKey]: await this.SourceKey(s.Namespace, S.RealmMasterKey, S.MasterKeyKey) }
            case S.IdpRealmSecretsDatabase:
                return { [S.DatabaseUrlKey]: await this.SourceKey(s.Namespace, S.PostgresRealmSecretsIdp, S.DatabaseUrlKey) }
            default:
                // The console certificate for the sign-in service's Ingress (the minted one or the operator's).
                return {
                    [S.TlsCertKey]: await this.SourceKey(s.Namespace, spec.Name, S.TlsCertKey),
                    [S.TlsKeyKey]: await this.SourceKey(s.Namespace, spec.Name, S.TlsKeyKey),
                }
        }
    }

    private async SourceKey(namespace: string, name: string, key: string): Promise<Buffer>
    {
        const B = EngineBootstrap
        const found = await this.kube.Get(this.SecretPath(namespace, name)) as SecretBody | undefined
        const value = found?.data?.[key]
        if (value === undefined)
        {
            throw new Error(B.MissingSourcePrefix + namespace + B.NamespaceSeparator + name)
        }
        return Buffer.from(value, B.Base64)
    }

    private async EnsureConfigurationObjects(namespace: string, component: string, report: { Created: string[]; Kept: string[] }): Promise<void>
    {
        const B = EngineBootstrap
        const metadata = (name: string): object => ({
            [B.NameKey]: name,
            [B.NamespaceKey]: namespace,
            [B.LabelsKey]: {
                ...K8sManifestBuilder.HiveLabelsOf(this.settings.HiveId),
                [ComponentConfigurationMounts.ComponentLabel]: component,
                [ComponentConfigurationMounts.ManagedByLabel]: ComponentConfigurationMounts.ManagedBy,
            },
        })
        const configMap = ComponentConfigurationMounts.ConfigMapNameOf(component)
        const secret = ComponentConfigurationMounts.SecretNameOf(component)
        const madeMap = await this.kube.Create(KubeResourceCatalog.PathOf(B.ConfigMapType, namespace), {
            [B.ApiVersionKey]: B.ConfigMapType.apiVersion, [B.KindKey]: B.ConfigMapKind, [B.MetadataKey]: metadata(configMap),
        })
        ;(madeMap ? report.Created : report.Kept).push(namespace + B.NamespaceSeparator + configMap)
        const madeSecret = await this.kube.Create(this.CollectionPath(namespace), {
            [B.ApiVersionKey]: B.SecretType.apiVersion, [B.KindKey]: B.SecretKind, [B.MetadataKey]: metadata(secret), [B.TypeKey]: EngineSecretSet.OpaqueType,
        })
        ;(madeSecret ? report.Created : report.Kept).push(namespace + B.NamespaceSeparator + secret)
    }

    /** Creates the namespace when absent; answers whether this call created it. */
    private async EnsureNamespace(name: string): Promise<boolean>
    {
        const B = EngineBootstrap
        if (await this.kube.Get(KubeResourceCatalog.PathOf(B.NamespaceType, undefined, name)) !== undefined)
        {
            return false
        }
        return await this.kube.Create(KubeResourceCatalog.PathOf(B.NamespaceType, undefined), {
            [B.ApiVersionKey]: B.NamespaceType.apiVersion,
            [B.KindKey]: B.NamespaceKind,
            [B.MetadataKey]: { [B.NameKey]: name, [B.LabelsKey]: { ...this.Labels(), ...B.PodSecurityLabels() }, [B.AnnotationsKey]: EngineBootstrap.KeepAnnotations() },
        })
    }

    private async Apply(namespace: string, spec: EngineSecretSpec, data: SecretData): Promise<void>
    {
        await this.kube.Apply(this.SecretPath(namespace, spec.Name), this.SecretOf(namespace, spec, data), EngineBootstrap.FieldManager)
    }

    private SecretOf(namespace: string, spec: EngineSecretSpec, data: SecretData): object
    {
        const B = EngineBootstrap
        return {
            [B.ApiVersionKey]: B.SecretType.apiVersion,
            [B.KindKey]: B.SecretKind,
            [B.MetadataKey]: { [B.NameKey]: spec.Name, [B.NamespaceKey]: namespace, [B.LabelsKey]: this.Labels(), [B.AnnotationsKey]: B.KeepAnnotations() },
            [B.TypeKey]: spec.Type,
            [B.DataKey]: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, (typeof v === 'string' ? Buffer.from(v, B.Utf8) : v).toString(B.Base64)])),
        }
    }

    private Labels(): Record<string, string>
    {
        return { ...K8sManifestBuilder.HiveLabelsOf(this.settings.HiveId), [EngineSecretSet.ManagedByLabel]: EngineSecretSet.ManagedByValue }
    }

    /**
     * `helm.sh/resource-policy: keep`. Helm never owns these Secrets (the hook Job made them), so uninstall leaves them anyway;
     * the annotation states the intent where an operator reads it, and protects them should a later chart ever adopt one.
     */
    private static KeepAnnotations(): Record<string, string>
    {
        return { [EngineSecretSet.KeepAnnotation]: EngineSecretSet.KeepValue }
    }

    private NamespaceOf(spec: EngineSecretSpec): string
    {
        return spec.Scope === EngineSecretScope.Idp ? this.settings.IdpNamespace : this.settings.Namespace
    }

    private CollectionPath(namespace: string): string
    {
        return KubeResourceCatalog.PathOf(EngineBootstrap.SecretType, namespace)
    }

    private SecretPath(namespace: string, name: string): string
    {
        return KubeResourceCatalog.PathOf(EngineBootstrap.SecretType, namespace, name)
    }

    /** A role's password and its URL on the hive Postgres Service (EnvironmentHiveDatabase: the one URL form and host). */
    private DatabaseSecret(role: string, database: string): SecretData
    {
        const password = this.Text(EngineBootstrap.PasswordBytes)
        return { [EngineSecretSet.PasswordKey]: password, [EngineSecretSet.DatabaseUrlKey]: EnvironmentHiveDatabase.UrlFor(role, database, password) }
    }

    /** URL-safe random text (no escaping needed in a URL or a file). */
    private Text(bytes: number): string
    {
        return this.random.Bytes(bytes).toString(EngineBootstrap.TextEncoding)
    }

    /** The console's directory seed: its tenant (the realm id from the first start) and its one hive. */
    private Seed(): TenantDirectorySeed
    {
        const s = this.settings
        const createdAt = this.clock().toISOString()
        return {
            tenant: { id: s.TenantId, clientId: s.TenantId, displayName: s.TenantName, createdAt, ownerEmail: s.OwnerEmail, ownerPrincipalId: TenantOwner.DefaultPrincipalId },
            hives: [{
                id: s.HiveId, tenantId: s.TenantId, displayName: s.HiveLabel,
                // Local + attach: the hive is the cluster this console runs in (the in-cluster orchestrator takes only that backend).
                cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Attach },
                agentTokenRef: K8sManifestBuilder.AgentTokenSecretNameOf(s.HiveId), createdAt,
            }],
        }
    }

    /** The realm sign-in service's RS256 signing key (PKCS#8 PEM, the key type IdpSigningKey loads). */
    private static SigningKeyPem(): string
    {
        const B = EngineBootstrap
        return generateKeyPairSync(B.RsaType, { modulusLength: B.RsaModulus }).privateKey.export({ type: B.Pkcs8, format: B.Pem }).toString()
    }

    private static IdpTlsData(material: TlsMaterial): SecretData
    {
        const S = EngineSecretSet
        return { [S.CaKey]: material.Ca, [S.ServerCertKey]: material.Cert, [S.ServerKeyKey]: material.Key }
    }
}
