import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { KubeResourceCatalog, type KubeApiClient, type KubeTypeRef } from '@pragmatic-tech-ai/pragmatic-kube'
import { ConsoleFingerprintKeys, HiveBackend, InfraMode, K8sManifestBuilder, TenantOwner, type TenantDirectorySeed } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import type { BootstrapSettings } from './bootstrap-settings.js'
import { EngineSecretOrigin, EngineSecretScope, EngineSecretSet, type EngineSecretSpec } from './engine-secret-set.js'
import type { ITlsMinter, TlsMaterial } from './tls-minter.js'

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
    private static readonly UrlScheme = 'postgres://'
    private static readonly UserSeparator = ':'
    private static readonly HostSeparator = '@'
    private static readonly PathSeparator = '/'
    private static readonly NamespaceSeparator = '/'
    private static readonly PostgresPort = 5432
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
    private static readonly MissingSourcePrefix = 'the bootstrap cannot copy a Secret whose source is absent: '

    public constructor(
        private readonly kube: KubeApiClient,
        private readonly settings: BootstrapSettings,
        private readonly tls: ITlsMinter,
        private readonly random: IRandomSource = new CryptoRandomSource(),
        private readonly clock: () => Date = () => new Date())
    {
    }

    public async Run(): Promise<EngineBootstrapReport>
    {
        const B = EngineBootstrap
        const S = EngineSecretSet
        const s = this.settings
        const report = { Created: [] as string[], Kept: [] as string[], Refreshed: [] as string[] }
        await this.EnsureNamespace(s.IdpNamespace)
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

    /** Creates a minted Secret when absent; false (kept, untouched) when one exists. */
    private async CreateMinted(namespace: string, spec: EngineSecretSpec): Promise<boolean>
    {
        const S = EngineSecretSet
        if (spec.Name === S.ConsoleTls)
        {
            return await this.CreateConsoleTls(namespace, spec)
        }
        return await this.kube.Create(this.CollectionPath(namespace), this.SecretOf(namespace, spec, this.Mint(spec)))
    }

    /**
     * The self-signed console certificate (console, sign-in service and every environment of the base domain) and its CA:
     * minted as a pair only when the certificate is absent; the CA Secret then follows the new certificate. An existing
     * certificate is kept with whatever CA it came with.
     */
    private async CreateConsoleTls(namespace: string, spec: EngineSecretSpec): Promise<boolean>
    {
        const S = EngineSecretSet
        const B = EngineBootstrap
        const s = this.settings
        if (await this.kube.Get(this.SecretPath(namespace, spec.Name)) !== undefined)
        {
            return false
        }
        const material = this.tls.Mint([s.ConsoleHost, s.IdpHost, B.WildcardPrefix + s.BaseDomain])
        const created = await this.kube.Create(this.CollectionPath(namespace), this.SecretOf(namespace, spec, { [S.TlsCertKey]: material.Cert, [S.TlsKeyKey]: material.Key }))
        if (created)
        {
            const ca: EngineSecretSpec = { Name: S.DevCa, Scope: EngineSecretScope.Engine, Keys: [S.CaKey], Type: S.OpaqueType, Origin: EngineSecretOrigin.Minted }
            await this.Apply(namespace, ca, { [S.CaKey]: material.Ca })
        }
        return created
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
            case S.TenantAdminMasterKey:
            case S.IdpMasterKey:
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
                throw new Error(B.MissingSourcePrefix + spec.Name)
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

    private async EnsureNamespace(name: string): Promise<void>
    {
        const B = EngineBootstrap
        if (await this.kube.Get(KubeResourceCatalog.PathOf(B.NamespaceType, undefined, name)) !== undefined)
        {
            return
        }
        await this.kube.Create(KubeResourceCatalog.PathOf(B.NamespaceType, undefined), {
            [B.ApiVersionKey]: B.NamespaceType.apiVersion,
            [B.KindKey]: B.NamespaceKind,
            [B.MetadataKey]: { [B.NameKey]: name, [B.LabelsKey]: this.Labels(), [B.AnnotationsKey]: EngineBootstrap.KeepAnnotations() },
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

    /** A role's password and its URL on the hive Postgres Service. */
    private DatabaseSecret(role: string, database: string): SecretData
    {
        const B = EngineBootstrap
        const password = this.Text(B.PasswordBytes)
        const url = B.UrlScheme + role + B.UserSeparator + password + B.HostSeparator + this.settings.PostgresHost + B.UserSeparator + B.PostgresPort + B.PathSeparator + database
        return { [EngineSecretSet.PasswordKey]: password, [EngineSecretSet.DatabaseUrlKey]: url }
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
                cluster: { backend: HiveBackend.Private, mode: InfraMode.Attach }, registry: { mode: InfraMode.Attach },
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
