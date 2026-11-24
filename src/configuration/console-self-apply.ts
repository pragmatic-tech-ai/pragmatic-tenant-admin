import { ApplyOutcome, AppliedConfigurationEntries, AppliedConfigurationKeys, ConfigurationPreparationStatus, ConfigurationScope, type ApplyRecord, type ApplyTarget, type IConfigurationRepository } from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeContentType, KubeResourceCatalog, type KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import { ConfigurationService } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { KubeConfigurationApplier } from './kube-configuration-applier.js'
import { RolloutWatch, SystemRolloutClock, type IRolloutClock } from './rollout-watch.js'

/** How the console's own apply ended once the console it started was watched. */
export enum SelfApplyOutcome
{
    /** The console's Deployment was ready (its readiness probe passed) for StableMs: applied, what ran before forgotten. */
    Applied = 'applied',
    /** It was not ready by the deadline: recorded rollout-not-ready and what ran before put back. */
    Reverted = 'reverted',
    /** The console stopped before either. */
    Stopped = 'stopped',
}

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
 * - a console that starts (`Settle`, before it listens) marks older pending applies `superseded`; the newest one it was
 *   not started by (it does not run that version) fails `rollout-not-ready` at once and what was kept is removed;
 * - the newest one it does run is not complete until this console is proven: `AwaitReady` (after it listens) reads its
 *   own Deployment, whose readiness the kubelet judges by the rendered probe, until it has been ready for StableMs; then
 *   the apply is applied and what was kept is removed, so a later, unrelated start failure never reverts to a
 *   configuration from before the last good apply. When it is not ready by ReadyTimeoutMs after the apply was requested
 *   (a console that starts but never passes its probe, or one restarted past that deadline), the apply fails
 *   `rollout-not-ready` and what ran before is put back (retried until it lands): the Deployment is recreated from the
 *   last good template. A console whose listener does not bind puts it back at once (`Abandon`). The previous version is
 *   therefore kept until the new one is proven healthy, and a configuration that starts but never readies cannot take
 *   the tenant's console away.
 */
export class ConsoleSelfApply
{
    public static readonly PreviousKey = 'previous.json'
    public static readonly PreviousAnnotationsKey = 'previous-annotations.json'
    public static readonly PreviousHashAnnotation = 'pragmatic-tech.ai/previous-configuration-hash'
    public static readonly SupersededDetail = 'superseded'
    public static readonly InterruptedDetail = 'interrupted: the console restarted during the roll'
    /** From the apply's request: the old console stops, the new one starts (with its database) and must become ready. */
    public static readonly ReadyTimeoutMs = 180_000
    /** How long the console's Deployment must stay ready before its own apply counts as applied. */
    public static readonly StableMs = 10_000
    public static readonly PollMs = 2_000
    /** A console that starts past the deadline (restarted, rescheduled) still gets this long to be proven before it puts back. */
    public static readonly RestartGraceMs = 30_000
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

    private stopped = false
    private proving = false

    public constructor(
        private readonly client: KubeApiClient,
        public readonly Self: ApplyTarget,
        private readonly component: string,
        private readonly clock: IRolloutClock = new SystemRolloutClock(),
    )
    {
    }

    public Is(target: ApplyTarget): boolean
    {
        return target.Equals(this.Self)
    }

    /** Whether this console is still proving the apply it was started by (Settle answered one; AwaitReady or Abandon has not
     *  ended): no new apply to the console may begin meanwhile, or what ran before would be replaced by an unproven version. */
    public get Proving(): boolean
    {
        return this.proving
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
        // The entries prepared for the next release stay, with their status: they are about other descriptors (R3).
        for (const [key, value] of Object.entries(current.data ?? {}))
        {
            if (AppliedConfigurationEntries.DigestOfKey(key) !== undefined && typeof value === 'string') data[key] = value
        }
        const annotations = ConfigurationPreparationStatus.Of(current.metadata?.annotations).Over(S.KeptAnnotations(current.data?.[S.PreviousAnnotationsKey]))
        await this.client.Apply(path, {
            [S.ApiVersionKey]: S.ConfigMapType.apiVersion,
            [S.KindKey]: S.ConfigMapType.kind,
            [S.MetadataKey]: {
                [S.NameKey]: current.metadata?.name,
                [S.NamespaceKey]: current.metadata?.namespace,
                [S.LabelsKey]: current.metadata?.labels,
                [S.AnnotationsKey]: annotations,
            },
            [S.DataKey]: data,
        }, KubeConfigurationApplier.FieldManager)
        return true
    }

    /**
     * Settles the console's own pending applies by what this (started) console runs, before it listens: older ones are
     * superseded, the newest one it does not run fails `rollout-not-ready`, and what was kept is forgotten. Answers the
     * newest one it runs, which stays pending (with what ran before kept) until AwaitReady proves this console.
     */
    public async Settle(repository: IConfigurationRepository, tenantId: string): Promise<ApplyRecord | undefined>
    {
        const S = ConsoleSelfApply
        const scope = new ConfigurationScope(tenantId, this.component)
        const pending = (await repository.Applies(scope)).filter(a => a.Outcome === ApplyOutcome.Pending && a.Target.Equals(this.Self))
        const map = await this.client.Get(this.ConfigMapPath()) as ConfigMapShape | undefined
        let awaiting: ApplyRecord | undefined
        try
        {
            if (pending.length === 0) return undefined
            const running = await this.RunningVersion(map)
            const newest = pending.reduce((a, b) => (b.Id > a.Id ? b : a))
            for (const apply of pending.filter(a => a !== newest))
            {
                await repository.CompleteApply(scope, apply.Id, ApplyOutcome.Failed, S.SupersededDetail)
            }
            if (running !== newest.Version)
            {
                await repository.CompleteApply(scope, newest.Id, ApplyOutcome.Failed, ConfigurationService.RolloutNotReadyDetail)
                return undefined
            }
            awaiting = newest
            this.proving = true
            return newest
        }
        finally
        {
            // What was kept goes even when the record cannot be written, unless this console must still prove the apply that
            // started it: it must never outlive the start that settled.
            if (awaiting === undefined) await this.Forget(map)
        }
    }

    /**
     * Watches this console's own Deployment until it has been ready for StableMs (applied, what ran before forgotten) or
     * ReadyTimeoutMs after `apply` was requested passed without that (failed `rollout-not-ready`, what ran before put back,
     * retried every PollMs until it lands). Stop ends it early.
     */
    public async AwaitReady(repository: IConfigurationRepository, tenantId: string, apply: ApplyRecord): Promise<SelfApplyOutcome>
    {
        try
        {
            return await this.Watch(repository, tenantId, apply)
        }
        finally
        {
            this.proving = false
        }
    }

    private async Watch(repository: IConfigurationRepository, tenantId: string, apply: ApplyRecord): Promise<SelfApplyOutcome>
    {
        const S = ConsoleSelfApply
        // A console started past the deadline (restarted or rescheduled during its proof) is given the grace to be proven.
        const deadline = Math.max(apply.RequestedAt.getTime() + S.ReadyTimeoutMs, this.clock.Now() + S.RestartGraceMs)
        let readySince: number | undefined
        while (!this.stopped)
        {
            const now = this.clock.Now()
            readySince = await this.IsReady(apply) ? readySince ?? now : undefined
            if (readySince !== undefined && now - readySince >= S.StableMs)
            {
                const map = await this.client.Get(this.ConfigMapPath()) as ConfigMapShape | undefined
                try
                {
                    await repository.CompleteApply(new ConfigurationScope(tenantId, this.component), apply.Id, ApplyOutcome.Applied, S.NoText)
                }
                finally
                {
                    await this.Forget(map)
                }
                return SelfApplyOutcome.Applied
            }
            if (readySince === undefined && now >= deadline)
            {
                return await this.Abandon(repository, tenantId, apply) ? SelfApplyOutcome.Reverted : SelfApplyOutcome.Stopped
            }
            await this.clock.Sleep(S.PollMs)
        }
        return SelfApplyOutcome.Stopped
    }

    /**
     * Puts back what ran before, retrying every PollMs until it lands or Stop, then fails the console's own pending `apply`
     * (`rollout-not-ready`); answers whether anything was put back. The put-back comes first: a console stopped between
     * the two leaves the apply pending, so the next start settles it again (a pending apply it no longer runs fails at
     * once; one it still runs is watched and put back), and what was kept is never forgotten before it is back. For a
     * console not ready by the deadline: it keeps running, so it keeps trying.
     */
    public async Abandon(repository: IConfigurationRepository, tenantId: string, apply: ApplyRecord): Promise<boolean>
    {
        const S = ConsoleSelfApply
        try
        {
            while (!this.stopped)
            {
                try
                {
                    const reverted = await this.Revert()
                    await this.Fail(repository, tenantId, apply)
                    return reverted
                }
                catch
                {
                    await this.clock.Sleep(S.PollMs)
                }
            }
            return false
        }
        finally
        {
            this.proving = false
        }
    }

    /**
     * Puts back what ran before once, then fails the console's own pending `apply` (a refused put-back throws and leaves the
     * apply pending). For a console that stops right after (its listener did not bind): its restart settles it again, and
     * the process never hangs on a put-back the cluster refuses.
     */
    public async AbandonOnce(repository: IConfigurationRepository, tenantId: string, apply: ApplyRecord): Promise<void>
    {
        try
        {
            await this.Revert()
            await this.Fail(repository, tenantId, apply)
        }
        finally
        {
            this.proving = false
        }
    }

    private async Fail(repository: IConfigurationRepository, tenantId: string, apply: ApplyRecord): Promise<void>
    {
        await repository.CompleteApply(new ConfigurationScope(tenantId, this.component), apply.Id, ApplyOutcome.Failed, ConfigurationService.RolloutNotReadyDetail).catch(() => undefined)
    }

    /** Ends AwaitReady and Abandon at their next step (the console is closing). */
    public Stop(): void
    {
        this.stopped = true
    }

    // Ready: the Deployment still runs the version of `apply` and every replica of its template is available.
    private async IsReady(apply: ApplyRecord): Promise<boolean>
    {
        try
        {
            const deployment = await this.client.Get(this.DeploymentPath()) as Parameters<typeof RolloutWatch.IsReady>[0] | undefined
            if (deployment === undefined || !RolloutWatch.IsReady(deployment)) return false
            return await this.RunningVersion(await this.client.Get(this.ConfigMapPath()) as ConfigMapShape | undefined) === apply.Version
        }
        catch
        {
            return false
        }
    }

    /**
     * Fails the pending applies to other components' Deployments, which were watched by the console that has just
     * restarted (its watch is gone; the file and hash it wrote stay as they were). An admin re-applies the version they
     * want from the console.
     */
    public async SettleInterrupted(repository: IConfigurationRepository, tenantId: string, components: readonly string[]): Promise<void>
    {
        const S = ConsoleSelfApply
        for (const component of components)
        {
            const scope = new ConfigurationScope(tenantId, component)
            for (const apply of await repository.Applies(scope))
            {
                if (apply.Outcome === ApplyOutcome.Pending && !apply.Target.Equals(this.Self))
                {
                    await repository.CompleteApply(scope, apply.Id, ApplyOutcome.Failed, S.InterruptedDetail)
                }
            }
        }
    }

    private async Forget(map: ConfigMapShape | undefined): Promise<void>
    {
        const S = ConsoleSelfApply
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
