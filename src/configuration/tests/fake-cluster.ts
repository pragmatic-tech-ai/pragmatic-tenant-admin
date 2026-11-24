import { KubeContentType, KubeMethod, type IKubeTransport, type KubeResponse } from '@pragmatic-tech-ai/pragmatic-kube'
import type { IRolloutClock } from '../rollout-watch.js'

type Obj = Record<string, any>

/** A clock the watch advances itself: every Sleep moves time on at once. */
export class FakeClock implements IRolloutClock
{
    public Current = 0
    public readonly Slept: number[] = []

    public Now(): number
    {
        return this.Current
    }

    public async Sleep(ms: number): Promise<void>
    {
        this.Slept.push(ms)
        this.Current += ms
    }
}

/**
 * A tiny Kubernetes API over JSON objects by path: GET, POST (create, 409 when there), PATCH (server-side apply replaces,
 * strategic merge and merge patch merge, null removes) and DELETE. A Deployment rolls like the controller with
 * `maxUnavailable: 0, maxSurge: 1` and one replica: a changed pod template starts a new pod, which becomes ready only when
 * `Readies(template)` says so; until then the old pod keeps running and serving (`Serving` is never empty mid-roll). A
 * template equal to the one the old pod runs (a revert) is that pod's again at once. A Deployment named in `Recreated` has
 * one pod whose readiness follows `Readies` too (no old pod serves meanwhile). With `minReadySeconds`, a ready pod counts
 * as available only once it has been ready that long by `Clock` (a pod's readiness is read at every GET), and a surge pod
 * replaces the old one only once available.
 */
export class FakeCluster implements IKubeTransport
{
    public readonly Objects = new Map<string, Obj>()
    public readonly Calls: { method: KubeMethod; path: string; body: unknown; type: KubeContentType }[] = []
    /** Whether a pod running this template becomes ready. */
    public Readies: (template: Obj) => boolean = () => true
    /** The template each running pod runs, by deployment path; the first one serves. */
    public readonly Pods = new Map<string, Obj[]>()
    /** Every moment some deployment had no ready pod (must stay empty). */
    public readonly Outages: string[] = []
    /** Status codes to answer instead, by `METHOD path` (consumed once). */
    public readonly Refusals = new Map<string, number>()
    /** Deployments whose only pod is judged by `Readies` (a recreated workload: no old pod serves). */
    public readonly Recreated = new Set<string>()
    /** The time `minReadySeconds` is counted by. */
    public Clock: FakeClock | undefined
    // Since when each pod (by deployment path and template) has been ready; the pods a Put starts were ready long before.
    private readonly readySince = new Map<string, number>()

    public Put(path: string, object: Obj): void
    {
        this.Objects.set(path, structuredClone(object))
        if (object.kind === 'Deployment')
        {
            object.metadata.generation = 1
            this.Pods.set(path, [structuredClone(object.spec.template)])
            this.readySince.set(FakeCluster.PodKey(path, object.spec.template), Number.NEGATIVE_INFINITY)
            this.Objects.set(path, structuredClone(object))
            this.Settle(path)
        }
    }

    public async Send(method: KubeMethod, path: string, body: string | undefined, type: KubeContentType): Promise<KubeResponse>
    {
        const parsed = body === undefined ? undefined : JSON.parse(body)
        this.Calls.push({ method, path, body: parsed, type })
        const bare = path.split('?')[0]
        const refusal = this.Refusals.get(`${method} ${bare}`)
        if (refusal !== undefined)
        {
            this.Refusals.delete(`${method} ${bare}`)
            return { status: refusal, body: JSON.stringify({ message: 'refused' }) }
        }
        switch (method)
        {
            case KubeMethod.Get:
                return this.Get(bare, path)
            case KubeMethod.Post:
                return this.Create(bare, parsed)
            case KubeMethod.Patch:
                return this.Patch(bare, parsed, type)
            case KubeMethod.Delete:
                return this.Objects.delete(bare) ? { status: 200, body: '{}' } : { status: 404, body: '{}' }
            default:
                return { status: 405, body: '{}' }
        }
    }

    private Get(bare: string, path: string): KubeResponse
    {
        const found = this.Objects.get(bare)
        if (found !== undefined)
        {
            this.Tick(bare)
            return { status: 200, body: JSON.stringify(this.Objects.get(bare)) }
        }
        const selector = new URL(path, 'http://x').searchParams.get('labelSelector')
        const items = [...this.Objects.entries()]
            .filter(([key]) => key.startsWith(bare + '/') && !key.slice(bare.length + 1).includes('/'))
            .map(([, value]) => value)
            .filter(item => FakeCluster.Matches(item.metadata?.labels ?? {}, selector))
        return items.length > 0 || bare.endsWith('s') ? { status: 200, body: JSON.stringify({ items }) } : { status: 404, body: '{}' }
    }

    private Create(bare: string, body: Obj): KubeResponse
    {
        const path = `${bare}/${body.metadata.name}`
        if (this.Objects.has(path)) return { status: 409, body: '{}' }
        this.Objects.set(path, structuredClone(body))
        return { status: 201, body: '{}' }
    }

    private Patch(bare: string, body: Obj, type: KubeContentType): KubeResponse
    {
        const current = this.Objects.get(bare)
        if (type === KubeContentType.ApplyPatch)
        {
            this.Objects.set(bare, structuredClone(body))
            return { status: 200, body: '{}' }
        }
        if (current === undefined) return { status: 404, body: '{}' }
        const before = JSON.stringify(current.spec?.template)
        const merged = FakeCluster.Merge(current, body)
        this.Objects.set(bare, merged)
        if (merged.kind === 'Deployment' && JSON.stringify(merged.spec.template) !== before)
        {
            merged.metadata.generation += 1
            this.Roll(bare, merged)
        }
        return { status: 200, body: '{}' }
    }

    /** A new template: a surge pod next to the old one, or the old pod's own template again (a revert). */
    private Roll(path: string, deployment: Obj): void
    {
        const pods = this.Pods.get(path) ?? []
        const template = deployment.spec.template
        const own = pods.find(p => JSON.stringify(p) === JSON.stringify(template))
        this.Pods.set(path, own !== undefined ? [own] : [pods[0], structuredClone(template)])
        this.Settle(path)
    }

    // The controller's view at every read: the pods' readiness now, and a surge pod that is available replaces the old one.
    private Tick(path: string): void
    {
        const pods = this.Pods.get(path)
        if (pods === undefined) return
        this.Settle(path)
        if (pods.length < 2 || !this.IsAvailable(path, pods[1])) return
        this.Pods.set(path, [pods[1]])
        this.Settle(path)
    }

    private IsReady(path: string, pod: Obj, index: number): boolean
    {
        return (index === 0 && !this.Recreated.has(path)) || this.Readies(pod)
    }

    private IsAvailable(path: string, pod: Obj): boolean
    {
        const since = this.readySince.get(FakeCluster.PodKey(path, pod))
        const minReady = (this.Objects.get(path)?.spec?.minReadySeconds ?? 0) * 1000
        return since !== undefined && (this.Clock?.Now() ?? 0) - since >= minReady
    }

    private static PodKey(path: string, pod: Obj): string
    {
        return path + ' ' + JSON.stringify(pod)
    }

    private Settle(path: string): void
    {
        const deployment = this.Objects.get(path)
        const pods = this.Pods.get(path) ?? []
        if (deployment === undefined) return
        const template = JSON.stringify(deployment.spec.template)
        const updated = pods.filter(p => JSON.stringify(p) === template)
        const now = this.Clock?.Now() ?? 0
        pods.forEach((p, i) =>
        {
            const key = FakeCluster.PodKey(path, p)
            if (!this.IsReady(path, p, i)) this.readySince.delete(key)
            else if (!this.readySince.has(key)) this.readySince.set(key, now)
        })
        const ready = pods.filter((p, i) => this.IsReady(path, p, i))
        if (ready.length === 0) this.Outages.push(path)
        deployment.status = {
            observedGeneration: deployment.metadata.generation,
            replicas: pods.length,
            updatedReplicas: updated.length,
            readyReplicas: ready.length,
            availableReplicas: pods.filter(p => this.IsAvailable(path, p)).length,
        }
    }

    private static Matches(labels: Record<string, string>, selector: string | null): boolean
    {
        if (selector === null) return true
        return selector.split(',').every(term =>
        {
            const [key, value] = term.split('=')
            return value === undefined ? key in labels : labels[key] === value
        })
    }

    private static Merge(target: Obj, patch: Obj): Obj
    {
        const out: Obj = structuredClone(target)
        for (const [key, value] of Object.entries(patch))
        {
            if (value === null) delete out[key]
            else if (typeof value === 'object' && !Array.isArray(value) && typeof out[key] === 'object' && out[key] !== null) out[key] = FakeCluster.Merge(out[key], value)
            else out[key] = structuredClone(value)
        }
        return out
    }
}
