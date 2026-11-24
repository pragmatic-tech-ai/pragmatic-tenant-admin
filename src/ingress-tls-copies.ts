import { KubeResourceCatalog, type KubeApiClient, type KubeTypeRef } from '@pragmatic-tech-ai/pragmatic-kube'

type SecretBody = { type?: string; data?: Record<string, string>; metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> } }

/** Starts and stops the refresh timer (setInterval in the pod; a manual one in tests). */
export interface IRefreshTimer
{
    Start(intervalMs: number, tick: () => void): void
    Stop(): void
}

export class IntervalRefreshTimer implements IRefreshTimer
{
    private handle: NodeJS.Timeout | undefined

    public Start(intervalMs: number, tick: () => void): void
    {
        this.Stop()
        this.handle = setInterval(tick, intervalMs)
        this.handle.unref()
    }

    public Stop(): void
    {
        if (this.handle !== undefined)
        {
            clearInterval(this.handle)
            this.handle = undefined
        }
    }
}

/**
 * Keeps the copies of the console's TLS Secret current (a chart-installed engine): the realm sign-in service's Ingress and
 * every environment's Ingress serve a copy in their own namespace, made once (at install, at the environment's creation).
 * A renewed source (cert-manager, an operator's rotation) reaches each existing copy within one interval; a namespace
 * without a copy is left alone. Writes only when the bytes differ, and names Secrets only in its log.
 */
export class IngressTlsCopies
{
    public static readonly IntervalMs = 10 * 60 * 1000
    public static readonly FieldManager = 'pragmatic-tenant-admin-tls-copies'
    private static readonly SecretType: KubeTypeRef = { apiVersion: 'v1', kind: 'Secret' }
    private static readonly SecretKind = 'Secret'
    private static readonly ApiVersionKey = 'apiVersion'
    private static readonly KindKey = 'kind'
    private static readonly MetadataKey = 'metadata'
    private static readonly NameKey = 'name'
    private static readonly NamespaceKey = 'namespace'
    private static readonly LabelsKey = 'labels'
    private static readonly TypeKey = 'type'
    private static readonly DataKey = 'data'
    private static readonly RefreshedPrefix = '[tls] refreshed the certificate copy in '
    private static readonly FailedPrefix = '[tls] refreshing the certificate copies failed: '
    private static readonly MissingSource = '[tls] the console certificate Secret is absent; copies left as they are'

    private running: Promise<void> | undefined

    public constructor(
        private readonly client: KubeApiClient,
        private readonly sourceNamespace: string,
        private readonly secretName: string,
        private readonly targets: () => readonly string[],
        private readonly log: (line: string) => void,
        private readonly timer: IRefreshTimer = new IntervalRefreshTimer())
    {
    }

    public Start(): void
    {
        this.timer.Start(IngressTlsCopies.IntervalMs, () => { void this.Tick() })
    }

    public async Stop(): Promise<void>
    {
        this.timer.Stop()
        await this.running
    }

    /** One pass; never throws (a failure is one log line, the next interval tries again). */
    public Tick(): Promise<void>
    {
        if (this.running === undefined)
        {
            const run = this.RefreshOnce()
                .then(() => undefined, error => this.log(IngressTlsCopies.FailedPrefix + (error instanceof Error ? error.message : String(error))))
                .finally(() => { this.running = undefined })
            this.running = run
            return run
        }
        return this.running
    }

    /** Answers the namespaces whose copy was rewritten. */
    public async RefreshOnce(): Promise<string[]>
    {
        const T = IngressTlsCopies
        const source = await this.client.Get(this.PathOf(this.sourceNamespace)) as SecretBody | undefined
        if (source?.data === undefined)
        {
            this.log(T.MissingSource)
            return []
        }
        const refreshed: string[] = []
        for (const namespace of this.targets())
        {
            const copy = await this.client.Get(this.PathOf(namespace)) as SecretBody | undefined
            if (copy === undefined || T.SameData(copy.data, source.data))
            {
                continue
            }
            await this.client.Apply(this.PathOf(namespace), {
                [T.ApiVersionKey]: T.SecretType.apiVersion,
                [T.KindKey]: T.SecretKind,
                [T.MetadataKey]: { [T.NameKey]: this.secretName, [T.NamespaceKey]: namespace, [T.LabelsKey]: copy.metadata?.labels ?? {} },
                [T.TypeKey]: copy.type ?? source.type,
                [T.DataKey]: source.data,
            }, T.FieldManager)
            this.log(T.RefreshedPrefix + namespace)
            refreshed.push(namespace)
        }
        return refreshed
    }

    private PathOf(namespace: string): string
    {
        return KubeResourceCatalog.PathOf(IngressTlsCopies.SecretType, namespace, this.secretName)
    }

    private static SameData(a: Record<string, string> | undefined, b: Record<string, string>): boolean
    {
        const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b)])
        return [...keys].every(key => a?.[key] === b[key])
    }
}
