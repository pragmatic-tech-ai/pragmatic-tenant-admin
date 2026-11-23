import { AppliedConfigurationCodec, AppliedConfigurationEntries, AppliedConfigurationKeys, ConfigurationPreparationStatus, type AppliedConfiguration, type ApplyTarget, type IAppliedConfigMap } from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeContentType, KubeResourceCatalog, type KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import { ComponentConfigurationMounts, ConfigurationApplyResult, type IConfigurationApplier } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ConfigMapWriteLock } from './config-map-write-lock.js'
import type { IApplyPreparation } from './configuration-preparer.js'
import type { ConsoleSelfApply } from './console-self-apply.js'
import { RolloutState, type RolloutWatch } from './rollout-watch.js'

type ObjectShape = { metadata?: Record<string, unknown>; data?: Record<string, unknown> }
type DeploymentShape = { spec?: { template?: { metadata?: { annotations?: Record<string, unknown> } } } }
type SecretShape = { metadata?: { resourceVersion?: unknown } }

/**
 * The applier over the console's own Kubernetes access (its pod's service account), watched and reverted:
 *
 * 1. reads what is there now: the ConfigMap `pragmatic-config-<component>` (or none) and the configuration hash on the
 *    Deployment's pod template (or none);
 * 2. writes the new ConfigMap (server-side apply under the configuration field manager, created or updated in place under
 *    the same name) and the new content hash on the pod template (a strategic-merge patch), which rolls the Deployment
 *    when the content changed; beside it, the revision of the component's secrets Secret, so a secret written since the
 *    last apply rolls the Deployment even for the same version (a component reads its secret files at start only); the
 *    entries prepared beside the old file for other descriptors (ConfigurationPreparer) are kept, the one for the
 *    applied descriptor dropped (the new file serves it);
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
    /** Configuration writes keep their own field manager: a re-apply of a hive manifest never prunes what they wrote. */
    public static readonly FieldManager = 'pragmatic-tenant-console-configuration'
    private static readonly ConfigMapType = { apiVersion: 'v1', kind: 'ConfigMap' }
    private static readonly SecretType = { apiVersion: 'v1', kind: 'Secret' }
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
        private readonly lock: ConfigMapWriteLock = new ConfigMapWriteLock(),
        private readonly preparation?: IApplyPreparation,
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
        const deployment = await this.client.Get(deploymentPath) as DeploymentShape | undefined
        const previousAnnotations = deployment?.spec?.template?.metadata?.annotations
        const previousHash = previousAnnotations?.[AppliedConfigurationKeys.HashAnnotation]
        const previousRevision = previousAnnotations?.[AppliedConfigurationKeys.SecretsRevisionAnnotation]
        const revision = await this.SecretsRevision(applied, target)
        // Read and written under the lock the preparer shares, so neither loses the other's change.
        const previous = await this.lock.Run(configMapPath, async () =>
        {
            const before = await this.client.Get(configMapPath) as ObjectShape | undefined
            const configMap = K.KeepPrepared(AppliedConfigurationCodec.ToConfigMap(applied, target.Namespace), before, applied.DescriptorDigest) as unknown as Record<string, unknown>
            const written = this.self?.Is(target) === true ? this.self.WithPrevious(configMap, before, typeof previousHash === 'string' ? previousHash : undefined) : configMap
            await this.client.Apply(configMapPath, written, K.FieldManager)
            return before
        })
        try
        {
            await this.client.Patch(deploymentPath, K.HashPatch(applied.ContentHash(), revision), KubeContentType.StrategicMerge)
        }
        catch (refused)
        {
            // The new file must not wait for the next restart: put the previous one back, then report the refusal.
            await this.Restore(configMapPath, previous).catch(() => undefined)
            throw refused
        }
        if (await this.watch.Await(target, this.timeoutMs) === RolloutState.Ready)
        {
            await this.PrepareAgain(applied, target)
            return ConfigurationApplyResult.Applied
        }
        try
        {
            await this.Restore(configMapPath, previous)
        }
        finally
        {
            // The old template comes back even when the file cannot be restored.
            await this.client.Patch(deploymentPath, K.HashPatch(typeof previousHash === 'string' ? previousHash : null, typeof previousRevision === 'string' ? previousRevision : null), KubeContentType.StrategicMerge)
        }
        const restored = K.AppliedOf(previous)
        if (restored !== undefined) await this.PrepareAgain(restored, target)
        return ConfigurationApplyResult.Reverted
    }

    // What runs there now is prepared for the release again (the entries beside it were derived from the file before).
    private async PrepareAgain(applied: AppliedConfiguration, target: ApplyTarget): Promise<void>
    {
        await this.preparation?.PrepareApplied(applied, target).catch(() => undefined)
    }

    private static AppliedOf(previous: ObjectShape | undefined): AppliedConfiguration | undefined
    {
        try
        {
            return previous === undefined ? undefined : AppliedConfigurationCodec.FromConfigMap(previous)
        }
        catch
        {
            return undefined
        }
    }

    // The previous file and its annotations come back; the entries prepared meanwhile and their status stay (they say
    // which file they were derived from, so they read as stale until the next preparation).
    private async Restore(path: string, previous: ObjectShape | undefined): Promise<void>
    {
        await this.lock.Run(path, () => this.RestoreLocked(path, previous))
    }

    private async RestoreLocked(path: string, previous: ObjectShape | undefined): Promise<void>
    {
        const K = KubeConfigurationApplier
        if (previous === undefined)
        {
            await this.client.Delete(path)
            return
        }
        const current = await this.client.Get(path) as ObjectShape | undefined
        const metadata: Record<string, unknown> = {}
        for (const key of K.KeptMetadata)
        {
            if (previous.metadata?.[key] !== undefined) metadata[key] = previous.metadata[key]
        }
        const annotations = Object.fromEntries(Object.entries((metadata[K.AnnotationsKey] ?? {}) as Record<string, unknown>)
            .filter((entry): entry is [string, string] => entry[0] !== K.LastApplied && typeof entry[1] === 'string'))
        metadata[K.AnnotationsKey] = ConfigurationPreparationStatus.Of(current?.metadata?.annotations).Over(annotations)
        const data: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(previous.data ?? {}))
        {
            if (AppliedConfigurationEntries.DigestOfKey(key) === undefined) data[key] = value
        }
        for (const [key, value] of Object.entries(current?.data ?? {}))
        {
            if (AppliedConfigurationEntries.DigestOfKey(key) !== undefined) data[key] = value
        }
        await this.client.Apply(path, {
            [K.ApiVersionKey]: K.ConfigMapType.apiVersion,
            [K.KindKey]: K.ConfigMapType.kind,
            [K.MetadataKey]: metadata,
            [K.DataKey]: data,
        }, K.FieldManager)
    }

    // The component's secrets Secret as it is now (its resourceVersion changes with every write), or null when it cannot be read.
    private async SecretsRevision(applied: AppliedConfiguration, target: ApplyTarget): Promise<string | null>
    {
        const K = KubeConfigurationApplier
        try
        {
            const path = KubeResourceCatalog.PathOf(K.SecretType, target.Namespace, ComponentConfigurationMounts.SecretNameOf(applied.Component))
            const secret = await this.client.Get(path) as SecretShape | undefined
            const revision = secret?.metadata?.resourceVersion
            return typeof revision === 'string' ? revision : null
        }
        catch
        {
            return null
        }
    }

    // The entries prepared for other descriptors (a release about to roll) stay beside the new file, with their status; the
    // applied file now serves its own descriptor, so an entry or refusal for that one goes (R3). Entries that do not read
    // are dropped (the console prepares them again at its next start).
    private static KeepPrepared(next: IAppliedConfigMap, previous: ObjectShape | undefined, digest: string): IAppliedConfigMap
    {
        let entries: ReadonlyMap<string, AppliedConfiguration>
        try
        {
            entries = AppliedConfigurationEntries.Prepared(previous)
        }
        catch
        {
            entries = new Map()
        }
        let out = next
        for (const [entryDigest, entry] of entries)
        {
            if (entryDigest !== digest) out = AppliedConfigurationEntries.With(out, entry)
        }
        const refusals = ConfigurationPreparationStatus.Of(previous?.metadata?.annotations).Refusals.filter(r => r.DescriptorDigest !== digest)
        let status = ConfigurationPreparationStatus.Of(out.metadata.annotations)
        for (const refusal of refusals) status = status.WithRefusal(refusal)
        out.metadata.annotations = status.Over(out.metadata.annotations)
        return out
    }

    // null removes an annotation (strategic merge), for a Deployment that had no configuration or no secret before.
    private static HashPatch(hash: string | null, revision: string | null): object
    {
        const K = KubeConfigurationApplier
        const annotations = { [AppliedConfigurationKeys.HashAnnotation]: hash, [AppliedConfigurationKeys.SecretsRevisionAnnotation]: revision }
        return { [K.SpecKey]: { [K.TemplateKey]: { [K.MetadataKey]: { [K.AnnotationsKey]: annotations } } } }
    }
}
