import { ApplyTarget, SettingValueEncoding, type IConfigurationRepository } from '@pragmatic-tech-ai/pragmatic-configuration'
import type { KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import { OciRegistryClient, ReleaseApp, ReleaseComponentDescriptors, ReleaseRegistry, ReleaseTrustKeys } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { ConfigurationService, K8sManifestBuilder, UnavailableComponentSecretWriter, UnavailableConfigurationApplier, type ConfigurationTarget, type EnvironmentRecord, type IConfigurationTargetSource } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { TenantAdminComponent } from '../tenant-admin-component.js'
import { ComponentSecretWriter } from './component-secret-writer.js'
import { ImageComponentDigests } from './image-component-digests.js'
import { KubeConfigurationApplier } from './kube-configuration-applier.js'
import { LabelConfigurationTargets, type IConfiguredNamespaces } from './label-configuration-targets.js'
import { ReleaseDescriptorCatalogue, type IReleaseDescriptorReader } from './release-descriptor-catalogue.js'
import { RolloutWatch } from './rollout-watch.js'
import { ConsoleSelfApply } from './console-self-apply.js'
import { ConfigurationPreparer } from './configuration-preparer.js'
import { ConfigMapWriteLock } from './config-map-write-lock.js'

/** The environment records the console's environment namespaces are read from. */
export interface IEnvironmentList
{
    List(): readonly EnvironmentRecord[]
}

/** The namespaces the console configures workloads in: its tenant's hive-bound environments', pragmatic-system and its
 *  realm sign-in service's. */
export class ConsoleConfiguredNamespaces implements IConfiguredNamespaces
{
    private static readonly EnvServer: string = ReleaseApp.EnvServer
    private static readonly UiUnpack: string = ReleaseApp.UiUnpack
    private static readonly HiveAgent: string = ReleaseApp.HiveAgent
    private static readonly TenantAdmin: string = ReleaseApp.TenantAdmin
    private static readonly TenantIdp: string = ReleaseApp.TenantIdp

    public constructor(public readonly Hive: string, private readonly tenantId: string, private readonly environments: IEnvironmentList)
    {
    }

    public async Namespaces(tenantId: string): Promise<readonly string[]>
    {
        if (tenantId !== this.tenantId) return []
        const environments = this.environments.List()
            .filter(r => r.tenantId === tenantId && r.hiveId === this.Hive)
            .flatMap(r => ConsoleConfiguredNamespaces.NamespaceOf(r.name))
        return [...new Set([K8sManifestBuilder.SystemNamespace, K8sManifestBuilder.IdpNameOf(tenantId), ...environments])]
    }

    public FixedDeployment(component: string, namespace: string): string | undefined
    {
        const B = K8sManifestBuilder
        const C = ConsoleConfiguredNamespaces
        if (namespace === B.SystemNamespace && component === C.HiveAgent) return B.HiveAgentNameOf(this.Hive)
        if (namespace === B.SystemNamespace && component === C.TenantAdmin) return B.TenantAdminNameOf(this.tenantId)
        if (namespace === B.IdpNameOf(this.tenantId) && component === C.TenantIdp) return B.IdpNameOf(this.tenantId)
        return undefined
    }

    public Expected(component: string, namespace: string, deployment: string, environment: string | undefined): boolean
    {
        const B = K8sManifestBuilder
        switch (component)
        {
            case ConsoleConfiguredNamespaces.EnvServer:
            case ConsoleConfiguredNamespaces.UiUnpack:
                return environment !== undefined && ConsoleConfiguredNamespaces.NamespaceOf(environment)[0] === namespace && deployment === B.ServerDeploymentOf(environment)
            case ConsoleConfiguredNamespaces.HiveAgent:
                return namespace === B.SystemNamespace && deployment === B.HiveAgentNameOf(this.Hive)
            case ConsoleConfiguredNamespaces.TenantAdmin:
                return namespace === B.SystemNamespace && deployment === B.TenantAdminNameOf(this.tenantId)
            case ConsoleConfiguredNamespaces.TenantIdp:
                return namespace === B.IdpNameOf(this.tenantId) && deployment === B.IdpNameOf(this.tenantId)
            default:
                return false
        }
    }

    // An environment whose name is no DNS label has no namespace the console wrote.
    private static NamespaceOf(name: string): string[]
    {
        try
        {
            return [K8sManifestBuilder.NamespaceOf(name)]
        }
        catch
        {
            return []
        }
    }
}

/** Outside a cluster the console sees no deployment to configure. */
export class NoConfigurationTargets implements IConfigurationTargetSource
{
    public async For(): Promise<readonly ConfigurationTarget[]>
    {
        return []
    }
}

/** The console's configuration service and the preparer it runs at start (undefined outside a cluster). */
export class ComposedConsoleConfiguration
{
    public constructor(public readonly Service: ConfigurationService, public readonly Preparer: ConfigurationPreparer | undefined)
    {
        Object.freeze(this)
    }
}

/** What the console's configuration is composed from. */
export interface ConsoleConfigurationParts
{
    Env: NodeJS.ProcessEnv
    Repository: IConfigurationRepository
    Environments: IEnvironmentList
    TenantId: string
    HiveId: string
    /** The console's Kubernetes access; undefined outside a cluster (nothing can be applied). */
    Client: KubeApiClient | undefined
}

/**
 * The tenant admin console's configuration repository, composed: descriptors from the signed platform release (the
 * mounted set of the release it runs, then the adopted releases from the registry when release keys are mounted),
 * targets by label, watched applies with revert, and component secrets in the customer's own cluster.
 */
export class ConsoleConfiguration
{
    /** The mounted descriptor set of the release the console runs (`digests.json` and one `<app>.json` each). */
    public static readonly DescriptorsDirVariable = 'PRAGMATIC_TENANT_ADMIN_DESCRIPTORS_DIR'
    /** The platform releases this hive adopted, newest first (a JSON array or a comma list). */
    public static readonly ReleasesVariable = 'PRAGMATIC_TENANT_ADMIN_RELEASES'
    /** The release-signing public keys (`<key id>.pub.pem`); without them the registry is not read. */
    public static readonly ReleaseKeysDirVariable = 'PRAGMATIC_TENANT_ADMIN_RELEASE_KEYS_DIR'
    /** The release registry; default ghcr.io. */
    public static readonly ReleaseRegistryVariable = 'PRAGMATIC_TENANT_ADMIN_RELEASE_REGISTRY'

    private constructor()
    {
    }

    public static Compose(parts: ConsoleConfigurationParts): ConfigurationService
    {
        return ConsoleConfiguration.Build(parts).Service
    }

    /** The service and, inside a cluster, the preparer the console runs at start (ConfigurationPreparer). */
    public static Build(parts: ConsoleConfigurationParts, log: (line: string) => void = () => undefined): ComposedConsoleConfiguration
    {
        const C = ConsoleConfiguration
        const env = parts.Env
        const catalogue = ReleaseDescriptorCatalogue.FromDirectory(C.DescriptorsDirOf(env), TenantAdminComponent.Descriptor(), C.RegistryOf(env), C.ReleasesOf(env))
        if (parts.Client === undefined)
        {
            return new ComposedConsoleConfiguration(new ConfigurationService(parts.Repository, catalogue, new NoConfigurationTargets(), new UnavailableConfigurationApplier(), new UnavailableComponentSecretWriter()), undefined)
        }
        const targets = new LabelConfigurationTargets(parts.Client, new ConsoleConfiguredNamespaces(parts.HiveId, parts.TenantId, parts.Environments), new ImageComponentDigests(), catalogue)
        // One lock for every write of a configuration object: the applier's and the preparer's never interleave.
        const lock = new ConfigMapWriteLock()
        const preparer = new ConfigurationPreparer(parts.Client, parts.Repository, catalogue, targets, lock, log)
        const applier = new KubeConfigurationApplier(parts.Client, new RolloutWatch(parts.Client), KubeConfigurationApplier.RolloutTimeoutMs, C.SelfOf(parts.Client, parts.TenantId, parts.HiveId), lock, preparer)
        return new ComposedConsoleConfiguration(new ConfigurationService(parts.Repository, catalogue, targets, applier, new ComponentSecretWriter(parts.Client), preparer), preparer)
    }

    /** The console's own Deployment, as its configuration target. */
    public static SelfOf(client: KubeApiClient, tenantId: string, hiveId: string): ConsoleSelfApply
    {
        return new ConsoleSelfApply(client, new ApplyTarget(hiveId, K8sManifestBuilder.SystemNamespace, K8sManifestBuilder.TenantAdminNameOf(tenantId)), TenantAdminComponent.Name)
    }

    public static DescriptorsDirOf(env: NodeJS.ProcessEnv): string
    {
        const dir = env[ConsoleConfiguration.DescriptorsDirVariable]
        return dir === undefined || dir === '' ? ReleaseDescriptorCatalogue.DefaultDirectory : dir
    }

    public static ReleasesOf(env: NodeJS.ProcessEnv): readonly string[]
    {
        const text = env[ConsoleConfiguration.ReleasesVariable]
        return text === undefined ? [] : SettingValueEncoding.ReadList(text) ?? []
    }

    /** The signed-release reader, or undefined when no release keys are mounted (then only the mounted set is read). */
    public static RegistryOf(env: NodeJS.ProcessEnv): IReleaseDescriptorReader | undefined
    {
        const C = ConsoleConfiguration
        const keys = env[C.ReleaseKeysDirVariable]
        if (keys === undefined || keys === '') return undefined
        const base = env[C.ReleaseRegistryVariable]
        const registry = new OciRegistryClient(base === undefined || base === '' ? ReleaseRegistry.DefaultBaseUrl : base)
        return new ReleaseComponentDescriptors(registry, ReleaseTrustKeys.FromDirectory(keys))
    }
}
