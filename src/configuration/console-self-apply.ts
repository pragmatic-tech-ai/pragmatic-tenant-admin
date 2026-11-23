import { ApplyOutcome, AppliedConfigurationKeys, ConfigurationScope, type ApplyTarget, type IConfigurationRepository } from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeContentType, KubeResourceCatalog, type KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import { ConfigurationService } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

type ConfigMapShape = { metadata?: { name?: unknown; namespace?: unknown; labels?: unknown; annotations?: Record<string, unknown> }; data?: Record<string, unknown> }
type DeploymentShape = { spec?: { template?: { metadata?: { annotations?: Record<string, unknown> } } } }

/**
 * The console applying its own configuration. Its Deployment is recreated (an embedded Postgres has one writer), so the
 * console that writes a new configuration is stopped before its roll can be watched; a configuration that stops the new
 * console from starting must still not leave the tenant without a console:
 *
 * - before the roll, the applier keeps what ran before beside the new file: data key `previous.json` (the previous
 *   `configuration.json`, empty when there was none), `previous-annotations.json` (its version, digest, hash and realm
 *   annotations) and the previous pod-template hash as an annotation;
 * - a console whose own configuration refuses its start (`Revert`, called from `Main` before it exits 78) puts back the
 *   previous pod-template hash first, then the previous file and annotations: the Deployment is recreated from the
 *   template the last good console ran, and a pod that starts in between reads the file the revert writes;
 * - a console that starts (`Settle`, before it listens) completes the newest apply it was started by (applied when it
 *   runs that version, else `rollout-not-ready`), marks older pending ones `superseded`, and removes what it kept, so a
 *   later, unrelated start failure never reverts to a configuration from before the last good apply.
 */
export class ConsoleSelfApply
{
    public static readonly PreviousKey = 'previous.json'
    public static readonly PreviousAnnotationsKey = 'previous-annotations.json'
    public static readonly PreviousHashAnnotation = 'pragmatic-tech.ai/previous-configuration-hash'
    public static readonly SupersededDetail = 'superseded'
    private static readonly ConfigMapType = { apiVersion: 'v1', kind: 'ConfigMap' }
    private static readonly DeploymentType = { apiVersion: 'apps/v1', kind: 'Deployment' }
    /** The annotations a restored configuration file goes with (`AppliedConfigurationCodec.ToConfigMap`). */
    private static readonly FileAnnotations: readonly string[] = [
        AppliedConfigurationKeys.VersionAnnotation, AppliedConfigurationKeys.DigestAnnotation, AppliedConfigurationKeys.HashAnnotation, AppliedConfigurationKeys.RealmAnnotation,
    ]
    private static readonly ApiVersionKey = 'apiVersion'
    private static readonly KindKey = 'kind'
    private static readonly MetadataKey = 'metadata'
    private static readonly AnnotationsKey = 'annotations'
    private static readonly DataKey = 'data'
    private static readonly SpecKey = 'spec'
    private static readonly TemplateKey = 'template'
    private static readonly NameKey = 'name'
    private static readonly NamespaceKey = 'namespace'
    private static readonly LabelsKey = 'labels'
    private static readonly NoText = ''

    public constructor(private readonly client: KubeApiClient, public readonly Self: ApplyTarget, private readonly component: string)
    {
    }

    public Is(target: ApplyTarget): boolean
    {
        return target.Equals(this.Self)
    }

    /** The ConfigMap to write for the console itself: the new one with what ran before kept beside it. */
    public WithPrevious(next: Record<string, unknown>, previous: ConfigMapShape | undefined, previousHash: string | undefined): Record<string, unknown>
    {
        const S = ConsoleSelfApply
        const file = previous?.data?.[AppliedConfigurationKeys.FileName]
        const kept: Record<string, string> = {}
        for (const key of S.FileAnnotations)
        {
            const value = previous?.metadata?.annotations?.[key]
            if (typeof value === 'string') kept[key] = value
        }
        const metadata = next[S.MetadataKey] as Record<string, unknown>
        const annotations = { ...(metadata[S.AnnotationsKey] as Record<string, string>), [S.PreviousHashAnnotation]: previousHash ?? S.NoText }
        return {
            ...next,
            [S.MetadataKey]: { ...metadata, [S.AnnotationsKey]: annotations },
            [S.DataKey]: {
                ...(next[S.DataKey] as Record<string, string>),
                [S.PreviousKey]: typeof file === 'string' ? file : S.NoText,
                [S.PreviousAnnotationsKey]: JSON.stringify(kept),
            },
        }
    }

    /** Puts back what ran before this console's configuration (answers whether there was anything to put back). */
    public async Revert(): Promise<boolean>
    {
        const S = ConsoleSelfApply
        const path = this.ConfigMapPath()
        const current = await this.client.Get(path) as ConfigMapShape | undefined
        const previous = current?.data?.[S.PreviousKey]
        if (current === undefined || typeof previous !== 'string') return false
        const hash = current.metadata?.annotations?.[S.PreviousHashAnnotation]
        // The template first: a pod started from it reads whatever file is there, and the file below follows at once.
        await this.client.Patch(this.DeploymentPath(), S.HashPatch(typeof hash === 'string' && hash !== S.NoText ? hash : null), KubeContentType.StrategicMerge)
        const data: Record<string, string> = previous === S.NoText ? {} : { [AppliedConfigurationKeys.FileName]: previous }
        await this.client.Apply(path, {
            [S.ApiVersionKey]: S.ConfigMapType.apiVersion,
            [S.KindKey]: S.ConfigMapType.kind,
            [S.MetadataKey]: {
                [S.NameKey]: current.metadata?.name,
                [S.NamespaceKey]: current.metadata?.namespace,
                [S.LabelsKey]: current.metadata?.labels,
                [S.AnnotationsKey]: S.KeptAnnotations(current.data?.[S.PreviousAnnotationsKey]),
            },
            [S.DataKey]: data,
        })
        return true
    }

    /** Completes the console's own pending applies by what this (started) console runs, and forgets what it kept. */
    public async Settle(repository: IConfigurationRepository, tenantId: string): Promise<void>
    {
        const S = ConsoleSelfApply
        const scope = new ConfigurationScope(tenantId, this.component)
        const pending = (await repository.Applies(scope)).filter(a => a.Outcome === ApplyOutcome.Pending && a.Target.Equals(this.Self))
        const map = await this.client.Get(this.ConfigMapPath()) as ConfigMapShape | undefined
        if (pending.length > 0)
        {
            const running = await this.RunningVersion(map)
            const newest = pending.reduce((a, b) => (b.Id > a.Id ? b : a))
            for (const apply of pending)
            {
                if (apply !== newest)
                {
                    await repository.CompleteApply(scope, apply.Id, ApplyOutcome.Failed, S.SupersededDetail)
                    continue
                }
                const applied = running === apply.Version
                await repository.CompleteApply(scope, apply.Id, applied ? ApplyOutcome.Applied : ApplyOutcome.Failed, applied ? S.NoText : ConfigurationService.RolloutNotReadyDetail)
            }
        }
        if (map?.data?.[S.PreviousKey] !== undefined)
        {
            await this.client.Patch(this.ConfigMapPath(), {
                [S.MetadataKey]: { [S.AnnotationsKey]: { [S.PreviousHashAnnotation]: null } },
                [S.DataKey]: { [S.PreviousKey]: null, [S.PreviousAnnotationsKey]: null },
            }, KubeContentType.MergePatch)
        }
    }

    // The version this console runs: its ConfigMap's, when its pod template carries that ConfigMap's hash.
    private async RunningVersion(map: ConfigMapShape | undefined): Promise<number | undefined>
    {
        const deployment = await this.client.Get(this.DeploymentPath()) as DeploymentShape | undefined
        const annotations = map?.metadata?.annotations ?? {}
        const hash = annotations[AppliedConfigurationKeys.HashAnnotation]
        const version = Number(annotations[AppliedConfigurationKeys.VersionAnnotation])
        const running = deployment?.spec?.template?.metadata?.annotations?.[AppliedConfigurationKeys.HashAnnotation]
        return typeof hash === 'string' && hash === running && Number.isSafeInteger(version) ? version : undefined
    }

    // The annotations kept beside the previous file; none when they were not kept or do not read.
    private static KeptAnnotations(text: unknown): Record<string, string>
    {
        if (typeof text !== 'string') return {}
        try
        {
            const parsed: unknown = JSON.parse(text)
            if (typeof parsed !== 'object' || parsed === null) return {}
            return Object.fromEntries(Object.entries(parsed).filter(([key, value]) => ConsoleSelfApply.FileAnnotations.includes(key) && typeof value === 'string')) as Record<string, string>
        }
        catch
        {
            return {}
        }
    }

    private ConfigMapPath(): string
    {
        return KubeResourceCatalog.PathOf(ConsoleSelfApply.ConfigMapType, this.Self.Namespace, AppliedConfigurationKeys.ObjectNamePrefix + this.component)
    }

    private DeploymentPath(): string
    {
        return KubeResourceCatalog.PathOf(ConsoleSelfApply.DeploymentType, this.Self.Namespace, this.Self.Deployment)
    }

    private static HashPatch(hash: string | null): object
    {
        const S = ConsoleSelfApply
        return { [S.SpecKey]: { [S.TemplateKey]: { [S.MetadataKey]: { [S.AnnotationsKey]: { [AppliedConfigurationKeys.HashAnnotation]: hash } } } } }
    }
}
