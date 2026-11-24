import { ApplyTarget } from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeResourceCatalog, type KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import { ComponentConfigurationMounts, ConfigurationTarget, type IConfigurationTargetSource } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ConfigurationReaders } from './configuration-readers.js'

/** The descriptor digest the image a container runs carries (its `ai.pragmatic-tech.component.digest` label). */
export interface IImageComponentDigests
{
    /** Undefined when it cannot be read (no digest in the reference, a registry out of reach, no label). */
    DigestOf(image: string): Promise<string | undefined>
}

/** The namespaces whose workloads the console configures, the hive they belong to, and the Deployment name the console's
 *  manifests give each component there. */
export interface IConfiguredNamespaces
{
    readonly Hive: string
    Namespaces(tenantId: string): Promise<readonly string[]>
    /** Whether `deployment` in `namespace` is the one the console's manifests render for `component` (for an environment
     *  workload, of `environment`); a Deployment merely carrying the labels is never a target. */
    /** The one Deployment name the manifests give a hive component in a namespace the console may only read by name (its
     *  Role there grants get and patch on named Deployments, never list); undefined where it may list (environments). */
    FixedDeployment(component: string, namespace: string): string | undefined
    Expected(component: string, namespace: string, deployment: string, environment: string | undefined): boolean
}

/** What a target's running descriptor maps to in the catalogue. */
export interface IDescriptorVersions
{
    VersionOf(component: string, digest: string): string | undefined
}

type DeploymentShape = {
    metadata?: { name?: unknown; labels?: Record<string, unknown> }
    spec?: { template?: { spec?: { containers?: ContainerShape[]; initContainers?: ContainerShape[] } } }
}
type ContainerShape = { name?: unknown; image?: unknown }

/**
 * A component's targets found by label, not by per-component code: every Deployment labelled
 * `component.pragmatic-tech.ai/<component>` (its value names the container that runs the component) and `app.kubernetes.io/managed-by=pragmatic-tenant-admin` in every
 * namespace the console manages (its environments' namespaces, pragmatic-system, the realm sign-in service's namespace).
 * A target is shown by its environment (the Deployment's `pragmatic/environment` label) or, for the hive's own
 * components, its namespace; when two targets would share a name, both are shown by their namespace. Only the Deployment
 * the console's manifests render for the component there counts (labels alone can be put on anything). Each carries the
 * descriptor digest of the image the component's container runs (read from the image's label), the component version
 * that digest belongs to, when known, and whether that version reads its configuration (ConfigurationReaders). A namespace the console cannot list is skipped, never an error for the others.
 */
export class LabelConfigurationTargets implements IConfigurationTargetSource
{
    private static readonly DeploymentType = { apiVersion: 'apps/v1', kind: 'Deployment' }
    private static readonly EnvironmentLabel = 'pragmatic/environment'
    private static readonly NameSeparator = '/'

    public constructor(
        private readonly kube: KubeApiClient,
        private readonly namespaces: IConfiguredNamespaces,
        private readonly images: IImageComponentDigests,
        private readonly versions: IDescriptorVersions,
    )
    {
    }

    public async For(component: string, tenantId: string): Promise<readonly ConfigurationTarget[]>
    {
        const L = LabelConfigurationTargets
        const selector = ComponentConfigurationMounts.SelectorOf(component)
        const out: ConfigurationTarget[] = []
        for (const namespace of await this.namespaces.Namespaces(tenantId))
        {
            let items: unknown[]
            try
            {
                items = await this.Candidates(component, namespace, selector)
            }
            catch
            {
                continue
            }
            for (const item of items)
            {
                const target = await this.TargetOf(component, namespace, item as DeploymentShape)
                if (target !== undefined) out.push(target)
            }
        }
        return LabelConfigurationTargets.Unique(out).sort((a, b) => a.Name.localeCompare(b.Name))
    }

    // Where the console may only get Deployments by name, the one the manifests render; elsewhere the labelled ones.
    private async Candidates(component: string, namespace: string, selector: string): Promise<unknown[]>
    {
        const L = LabelConfigurationTargets
        const fixed = this.namespaces.FixedDeployment(component, namespace)
        if (fixed === undefined) return this.kube.List(KubeResourceCatalog.PathOf(L.DeploymentType, namespace), selector)
        const found = await this.kube.Get(KubeResourceCatalog.PathOf(L.DeploymentType, namespace, fixed)) as DeploymentShape | undefined
        const labels = found?.metadata?.labels
        const labelled = ComponentConfigurationMounts.ContainerOf(labels, component) !== undefined && labels?.[ComponentConfigurationMounts.ManagedByLabel] === ComponentConfigurationMounts.ManagedBy
        return found !== undefined && labelled ? [found] : []
    }

    // Names shared by two targets become their namespaces, and names still shared then `<namespace>/<deployment>`.
    private static Unique(targets: readonly ConfigurationTarget[]): ConfigurationTarget[]
    {
        const L = LabelConfigurationTargets
        const byNamespace = L.Rename(targets, t => t.Target.Namespace)
        return L.Rename(byNamespace, t => t.Target.Namespace + L.NameSeparator + t.Target.Deployment)
    }

    private static Rename(targets: readonly ConfigurationTarget[], name: (t: ConfigurationTarget) => string): ConfigurationTarget[]
    {
        const counts = new Map<string, number>()
        for (const t of targets) counts.set(t.Name, (counts.get(t.Name) ?? 0) + 1)
        return targets.map(t => (counts.get(t.Name) ?? 0) > 1 ? new ConfigurationTarget(name(t), t.Target, t.DescriptorDigest, t.ComponentVersion, t.ReadsConfiguration) : t)
    }

    private async TargetOf(component: string, namespace: string, deployment: DeploymentShape): Promise<ConfigurationTarget | undefined>
    {
        const L = LabelConfigurationTargets
        const name = deployment.metadata?.name
        if (typeof name !== 'string') return undefined
        let target: ApplyTarget
        try
        {
            target = new ApplyTarget(this.namespaces.Hive, namespace, name)
        }
        catch
        {
            return undefined
        }
        const label = deployment.metadata?.labels?.[L.EnvironmentLabel]
        const environment = typeof label === 'string' ? label : undefined
        if (!this.namespaces.Expected(component, namespace, name, environment)) return undefined
        const image = L.ImageOf(component, deployment)
        const digest = image === undefined ? undefined : await this.images.DigestOf(image).catch(() => undefined)
        const version = digest === undefined ? undefined : this.versions.VersionOf(component, digest)
        return new ConfigurationTarget(environment ?? namespace, target, digest, version, ConfigurationReaders.Reads(component, version))
    }

    private static ImageOf(component: string, deployment: DeploymentShape): string | undefined
    {
        const pod = deployment.spec?.template?.spec
        const wanted = ComponentConfigurationMounts.ContainerOf(deployment.metadata?.labels, component)
        const container = [...(pod?.containers ?? []), ...(pod?.initContainers ?? [])].find(c => c.name === wanted)
        return typeof container?.image === 'string' ? container.image : undefined
    }
}
