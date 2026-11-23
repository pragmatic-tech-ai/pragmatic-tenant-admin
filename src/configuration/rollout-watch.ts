import type { ApplyTarget } from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeResourceCatalog, type KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'

/** How a watch keeps time: the clock and the wait between two reads. */
export interface IRolloutClock
{
    Now(): number
    Sleep(ms: number): Promise<void>
}

export class SystemRolloutClock implements IRolloutClock
{
    public Now(): number
    {
        return Date.now()
    }

    public Sleep(ms: number): Promise<void>
    {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}

/** Where a watched roll ended. */
export enum RolloutState
{
    Ready = 'ready',
    NotReady = 'not-ready',
}

type DeploymentStatusShape = {
    metadata?: { generation?: unknown }
    spec?: { replicas?: unknown }
    status?: { observedGeneration?: unknown; replicas?: unknown; updatedReplicas?: unknown; readyReplicas?: unknown }
}

/**
 * Waits for a Deployment's roll: ready once the controller has seen the newest template (observedGeneration at least
 * generation), every desired replica runs it (updatedReplicas) and that many updated pods are ready. Ready pods are
 * counted without the old ones still running (readyReplicas minus replicas not updated), so a roll whose new pod never
 * becomes ready is never taken for ready while the old pod keeps serving (maxUnavailable 0). A read that fails counts as
 * not ready yet; the deadline decides.
 */
export class RolloutWatch
{
    public static readonly PollMs = 2000
    private static readonly DeploymentType = { apiVersion: 'apps/v1', kind: 'Deployment' }
    private static readonly DefaultReplicas = 1

    public constructor(
        private readonly kube: KubeApiClient,
        private readonly clock: IRolloutClock = new SystemRolloutClock(),
        private readonly pollMs: number = RolloutWatch.PollMs,
    )
    {
    }

    public async Await(target: ApplyTarget, timeoutMs: number): Promise<RolloutState>
    {
        const path = KubeResourceCatalog.PathOf(RolloutWatch.DeploymentType, target.Namespace, target.Deployment)
        const deadline = this.clock.Now() + timeoutMs
        for (;;)
        {
            const deployment = await this.kube.Get(path).catch(() => undefined)
            if (deployment !== undefined && RolloutWatch.IsReady(deployment as DeploymentStatusShape)) return RolloutState.Ready
            if (this.clock.Now() >= deadline) return RolloutState.NotReady
            await this.clock.Sleep(this.pollMs)
        }
    }

    /** Whether the Deployment's newest template runs on every desired replica, all of them ready. */
    public static IsReady(deployment: DeploymentStatusShape): boolean
    {
        const W = RolloutWatch
        const generation = W.Count(deployment.metadata?.generation)
        const observed = W.Count(deployment.status?.observedGeneration)
        const desired = deployment.spec?.replicas === undefined ? W.DefaultReplicas : W.Count(deployment.spec.replicas)
        const replicas = W.Count(deployment.status?.replicas)
        const updated = W.Count(deployment.status?.updatedReplicas)
        const ready = W.Count(deployment.status?.readyReplicas)
        const old = Math.max(replicas - updated, 0)
        return observed >= generation && updated >= desired && ready - old >= desired
    }

    private static Count(value: unknown): number
    {
        return typeof value === 'number' && Number.isFinite(value) ? value : 0
    }
}
