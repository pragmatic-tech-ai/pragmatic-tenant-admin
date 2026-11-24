import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KubeApiClient, KubeMethod, type IKubeTransport, type KubeContentType, type KubeResponse } from '@pragmatic-tech-ai/pragmatic-kube'
import { IngressTlsCopies, type IRefreshTimer } from '../ingress-tls-copies.js'

class SecretsCluster implements IKubeTransport
{
    public readonly Secrets = new Map<string, any>()
    public readonly Applied: string[] = []

    public async Send(method: KubeMethod, path: string, body: string | undefined, _type: KubeContentType): Promise<KubeResponse>
    {
        const bare = path.split('?')[0]
        if (method === KubeMethod.Get)
        {
            const found = this.Secrets.get(bare)
            return found === undefined ? { status: 404, body: '{}' } : { status: 200, body: JSON.stringify(found) }
        }
        this.Applied.push(bare)
        this.Secrets.set(bare, JSON.parse(body ?? '{}'))
        return { status: 200, body: '{}' }
    }

    public Put(namespace: string, data: Record<string, string>): void
    {
        this.Secrets.set('/api/v1/namespaces/' + namespace + '/secrets/acme-tls', { type: 'kubernetes.io/tls', metadata: { name: 'acme-tls', labels: { 'pragmatic/hive': 'h' } }, data })
    }

    public Data(namespace: string): Record<string, string> | undefined
    {
        return this.Secrets.get('/api/v1/namespaces/' + namespace + '/secrets/acme-tls')?.data
    }
}

class ManualTimer implements IRefreshTimer
{
    public Interval = 0
    public Tick: (() => void) | undefined

    public Start(intervalMs: number, tick: () => void): void
    {
        this.Interval = intervalMs
        this.Tick = tick
    }

    public Stop(): void
    {
        this.Tick = undefined
    }
}

describe('IngressTlsCopies', () =>
{
    it('rewrites a stale copy, leaves a current one and a namespace without a copy alone', async () =>
    {
        const cluster = new SecretsCluster()
        cluster.Put('pragmatic-system', { 'tls.crt': 'bmV3', 'tls.key': 'a2V5' })
        cluster.Put('pragmatic-idp-acme', { 'tls.crt': 'b2xk', 'tls.key': 'a2V5' })
        cluster.Put('pragmatic-env-dev1', { 'tls.crt': 'bmV3', 'tls.key': 'a2V5' })
        const lines: string[] = []
        const copies = new IngressTlsCopies(new KubeApiClient(cluster), 'pragmatic-system', 'acme-tls', () => ['pragmatic-idp-acme', 'pragmatic-env-dev1', 'pragmatic-env-none'], line => lines.push(line))
        assert.deepEqual(await copies.RefreshOnce(), ['pragmatic-idp-acme'])
        assert.deepEqual(cluster.Data('pragmatic-idp-acme'), { 'tls.crt': 'bmV3', 'tls.key': 'a2V5' })
        assert.equal(cluster.Data('pragmatic-env-none'), undefined, 'no copy is created where none was made')
        assert.deepEqual(cluster.Applied, ['/api/v1/namespaces/pragmatic-idp-acme/secrets/acme-tls'])
        assert.ok(lines.every(line => !line.includes('bmV3') && !line.includes('a2V5')), 'never a value in the log')
        assert.deepEqual(await copies.RefreshOnce(), [], 'nothing to do once current')
    })

    it('runs every interval, never throws, and stops', async () =>
    {
        const cluster = new SecretsCluster()
        const timer = new ManualTimer()
        const lines: string[] = []
        const copies = new IngressTlsCopies(new KubeApiClient(cluster), 'pragmatic-system', 'acme-tls', () => ['x'], line => lines.push(line), timer)
        copies.Start()
        assert.equal(timer.Interval, IngressTlsCopies.IntervalMs)
        await copies.Tick()
        assert.match(lines[0], /certificate Secret is absent/)
        await copies.Stop()
        assert.equal(timer.Tick, undefined)
    })
})
