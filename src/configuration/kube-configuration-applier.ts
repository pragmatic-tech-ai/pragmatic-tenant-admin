import { AppliedConfigurationCodec, AppliedConfigurationKeys, type AppliedConfiguration, type ApplyTarget } from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeContentType, KubeResourceCatalog, type KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import { ConfigurationApplyResult, type IConfigurationApplier } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import type { ConsoleSelfApply } from './console-self-apply.js'
import { RolloutState, type RolloutWatch } from './rollout-watch.js'

type ObjectShape = { metadata?: Record<string, unknown>; data?: Record<string, unknown> }
type DeploymentShape = { spec?: { template?: { metadata?: { annotations?: Record<string, unknown> } } } }

/**
 * The applier over the console's own Kubernetes access (its pod's service account), watched and reverted:
 *
 * 1. reads what is there now: the ConfigMap `pragmatic-config-<component>` (or none) and the configuration hash on the
 *    Deployment's pod template (or none);
 * 2. writes the new ConfigMap (server-side apply, created or updated in place under the same name) and the new content
 *    hash on the pod template (a strategic-merge patch), which rolls the Deployment when the content changed;
 * 3. waits up to RolloutTimeoutMs for the roll (RolloutWatch). A surge-rolled workload (the hive agent,
 *    `maxUnavailable: 0`) keeps its old pod serving until a new one is ready; a recreated one (the console, the realm
 *    sign-in service, the env server: one writer on their data) is down while its new pod starts, at most until the
 *    revert below brings the previous configuration back;
 * 4. a roll that does not become ready is reverted: the previous ConfigMap content is restored (or the ConfigMap removed
 *    when there was none) and the previous hash put back on the pod template, which rolls the Deployment back to the
 *    template its old pods run; the answer is Reverted.
 *
 * The console's own Deployment is recreated (its embedded Postgres has one writer), so the console applying its own
 * configuration is stopped before the watch ends: what ran before is kept beside the new file (ConsoleSelfApply) for the
 * next console to put back if the new configuration refuses its start, and to settle the apply by.
 *
 * Nothing written is secret (secret settings are references). A refused write throws (the cluster's text stays out of
 * the apply record).
 */
export class KubeConfigurationApplier implements IConfigurationApplier
{
    public static readonly RolloutTimeoutMs = 120_000
    private static readonly ConfigMapType = { apiVersion: 'v1', kind: 'ConfigMap' }
    private static readonly DeploymentType = { apiVersion: 'apps/v1', kind: 'Deployment' }
    /** What a restored object keeps of its metadata: the server owns the rest. */
    private static readonly KeptMetadata = ['name', 'namespace', 'labels', 'annotations']
    /** kubectl's record of a client-side apply is never written back under the console's field manager. */
    private static readonly LastApplied = 'kubectl.kubernetes.io/last-applied-configuration'
    private static readonly MetadataKey = 'metadata'
    private static readonly DataKey = 'data'
    private static readonly ApiVersionKey = 'apiVersion'
    private static readonly KindKey = 'kind'
    private static readonly SpecKey = 'spec'
    private static readonly TemplateKey = 'template'
    private static readonly AnnotationsKey = 'annotations'

    public constructor(
        private readonly client: KubeApiClient,
        private readonly watch: RolloutWatch,
        private readonly timeoutMs: number = KubeConfigurationApplier.RolloutTimeoutMs,
        private readonly self?: ConsoleSelfApply,
    )
    {
    }

    public get Available(): boolean
    {
        return true
    }

    public async Apply(applied: AppliedConfiguration, target: ApplyTarget): Promise<ConfigurationApplyResult>
    {
        const K = KubeConfigurationApplier
        const configMapPath = KubeResourceCatalog.PathOf(K.ConfigMapType, target.Namespace, applied.ObjectName())
        const deploymentPath = KubeResourceCatalog.PathOf(K.DeploymentType, target.Namespace, target.Deployment)
        const previous = await this.client.Get(configMapPath) as ObjectShape | undefined
        const deployment = await this.client.Get(deploymentPath) as DeploymentShape | undefined
        const previousHash = deployment?.spec?.template?.metadata?.annotations?.[AppliedConfigurationKeys.HashAnnotation]
        const configMap = AppliedConfigurationCodec.ToConfigMap(applied, target.Namespace) as unknown as Record<string, unknown>
        const written = this.self?.Is(target) === true ? this.self.WithPrevious(configMap, previous, typeof previousHash === 'string' ? previousHash : undefined) : configMap
        await this.client.Apply(configMapPath, written)
        await this.client.Patch(deploymentPath, K.HashPatch(applied.ContentHash()), KubeContentType.StrategicMerge)
        if (await this.watch.Await(target, this.timeoutMs) === RolloutState.Ready)
        {
            return ConfigurationApplyResult.Applied
        }
        await this.Restore(configMapPath, previous)
        await this.client.Patch(deploymentPath, K.HashPatch(typeof previousHash === 'string' ? previousHash : null), KubeContentType.StrategicMerge)
        return ConfigurationApplyResult.Reverted
    }

    private async Restore(path: string, previous: ObjectShape | undefined): Promise<void>
    {
        const K = KubeConfigurationApplier
        if (previous === undefined)
        {
            await this.client.Delete(path)
            return
        }
        const metadata: Record<string, unknown> = {}
        for (const key of K.KeptMetadata)
        {
            if (previous.metadata?.[key] !== undefined) metadata[key] = previous.metadata[key]
        }
        const annotations = metadata[K.AnnotationsKey] as Record<string, unknown> | undefined
        if (annotations !== undefined)
        {
            metadata[K.AnnotationsKey] = Object.fromEntries(Object.entries(annotations).filter(([key]) => key !== K.LastApplied))
        }
        await this.client.Apply(path, {
            [K.ApiVersionKey]: K.ConfigMapType.apiVersion,
            [K.KindKey]: K.ConfigMapType.kind,
            [K.MetadataKey]: metadata,
            [K.DataKey]: previous.data ?? {},
        })
    }

    // null removes the annotation (strategic merge), for a Deployment that had no configuration before.
    private static HashPatch(hash: string | null): object
    {
        const K = KubeConfigurationApplier
        return { [K.SpecKey]: { [K.TemplateKey]: { [K.MetadataKey]: { [K.AnnotationsKey]: { [AppliedConfigurationKeys.HashAnnotation]: hash } } } } }
    }
}
