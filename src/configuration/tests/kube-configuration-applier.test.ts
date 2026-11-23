import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AppliedConfiguration, AppliedConfigurationCodec, ApplyTarget } from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeApiClient, KubeContentType, KubeMethod, type KubeResponse } from '@pragmatic-tech-ai/pragmatic-kube'
import { ConfigurationApplyResult } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { TenantAdminComponent } from '../../tenant-admin-component.js'
import { KubeConfigurationApplier } from '../kube-configuration-applier.js'
import { RolloutState, RolloutWatch } from '../rollout-watch.js'
import { ConfigurationFixture as F } from './configuration-fixture.js'
import { FakeClock, FakeCluster } from './fake-cluster.js'

type Obj = Record<string, any>

class ApplyWorld
{
    public static readonly Hash = 'pragmatic-tech.ai/configuration-hash'
    public static readonly Namespace = 'pragmatic-system'
    public static readonly Deployment = 'pragmatic-tenant-admin-acme'
    public static readonly DeploymentPath = '/apis/apps/v1/namespaces/pragmatic-system/deployments/pragmatic-tenant-admin-acme'
    public static readonly ConfigMapPath = '/api/v1/namespaces/pragmatic-system/configmaps/pragmatic-config-pragmatic-tenant-admin'

    public static Applied(version: number, port: number): AppliedConfiguration
    {
        const descriptor = TenantAdminComponent.Descriptor()
        return new AppliedConfiguration(F.Tenant, descriptor.Name, version, descriptor.Version, descriptor.ContentDigest(), { options: { core: { port, baseDomain: 'acme.test' } } })
    }

    public static Cluster(previous?: AppliedConfiguration): FakeCluster
    {
        const W = ApplyWorld
        const cluster = new FakeCluster()
        const annotations = previous === undefined ? {} : AppliedConfigurationCodec.PodTemplateAnnotations(previous)
        cluster.Put(W.DeploymentPath, {
            apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: W.Deployment, namespace: W.Namespace },
            spec: { replicas: 1, template: { metadata: { annotations }, spec: { containers: [{ name: 'tenant-admin', image: 'console:1' }] } } },
        })
        if (previous !== undefined) cluster.Put(W.ConfigMapPath, { ...AppliedConfigurationCodec.ToConfigMap(previous, W.Namespace), metadata: { ...AppliedConfigurationCodec.ToConfigMap(previous, W.Namespace).metadata, resourceVersion: '7', uid: 'u' } })
        return cluster
    }

    public static Applier(cluster: FakeCluster, clock = new FakeClock()): KubeConfigurationApplier
    {
        const client = new KubeApiClient(cluster)
        return new KubeConfigurationApplier(client, new RolloutWatch(client, clock))
    }

    public static Target(): ApplyTarget
    {
        return new ApplyTarget('h1', ApplyWorld.Namespace, ApplyWorld.Deployment)
    }

    public static PortOf(cluster: FakeCluster): number | undefined
    {
        const map = cluster.Objects.get(ApplyWorld.ConfigMapPath) as Obj | undefined
        return map === undefined ? undefined : (AppliedConfigurationCodec.FromConfigMap(map as never).Document as Obj).options.core.port
    }
}

/** A cluster that refuses the nth PATCH of one path (the first when n is 1), once. */
class RefusingNthPatch extends FakeCluster
{
    private seen = 0

    public constructor(private readonly refusedPath: string, private readonly nth: number)
    {
        super()
    }

    public override async Send(method: KubeMethod, path: string, body: string | undefined, type: KubeContentType): Promise<KubeResponse>
    {
        if (method === KubeMethod.Patch && path.split('?')[0] === this.refusedPath && ++this.seen === this.nth)
        {
            return { status: 403, body: JSON.stringify({ message: 'refused' }) }
        }
        return super.Send(method, path, body, type)
    }
}

describe('KubeConfigurationApplier', () =>
{
    it('writes the ConfigMap and the hash, and answers Applied once the new pod is ready', async () =>
    {
        const W = ApplyWorld
        const cluster = W.Cluster()
        const applied = W.Applied(1, 7100)
        assert.equal(await W.Applier(cluster).Apply(applied, W.Target()), ConfigurationApplyResult.Applied)
        assert.equal(W.PortOf(cluster), 7100)
        assert.equal(cluster.Objects.get(W.DeploymentPath)!.spec.template.metadata.annotations[W.Hash], applied.ContentHash())
        const write = cluster.Calls.find(c => c.method === KubeMethod.Patch && c.path.startsWith(W.ConfigMapPath))!
        assert.equal(write.type, KubeContentType.ApplyPatch)
    })

    it('a new pod that never readies is reverted to the previous version', async () =>
    {
        const W = ApplyWorld
        const before = W.Applied(1, 7100)
        const cluster = W.Cluster(before)
        cluster.Readies = template => template.metadata?.annotations?.[W.Hash] !== W.Applied(2, 1).ContentHash()
        const clock = new FakeClock()
        assert.equal(await W.Applier(cluster, clock).Apply(W.Applied(2, 1), W.Target()), ConfigurationApplyResult.Reverted)
        assert.ok(clock.Current >= KubeConfigurationApplier.RolloutTimeoutMs, 'waited the whole 120 s')
        assert.equal(W.PortOf(cluster), 7100, 'the previous ConfigMap content is back')
        const restored = cluster.Objects.get(W.ConfigMapPath)!
        assert.equal(restored.metadata.resourceVersion, undefined, 'server-owned metadata is not written back')
        assert.equal(cluster.Objects.get(W.DeploymentPath)!.spec.template.metadata.annotations[W.Hash], before.ContentHash(), 'the previous hash is back')
        assert.equal(cluster.Pods.get(W.DeploymentPath)!.length, 1, 'the stuck pod is gone; the old pod runs')
    })

    it('a surge-rolled workload keeps its old pod serving until the new one is ready, and through a revert', async () =>
    {
        const W = ApplyWorld
        const cluster = W.Cluster(W.Applied(1, 7100))
        cluster.Readies = () => false
        // A stateless workload (the hive agent) rolls with maxUnavailable 0: the old pod serves throughout.
        assert.equal(await W.Applier(cluster).Apply(W.Applied(2, 7200), W.Target()), ConfigurationApplyResult.Reverted)
        assert.deepEqual(cluster.Outages, [], 'never a moment without a ready console pod')
    })

    it('a first configuration that fails removes its ConfigMap and the hash', async () =>
    {
        const W = ApplyWorld
        const cluster = W.Cluster()
        cluster.Readies = template => template.metadata?.annotations?.[W.Hash] === undefined
        assert.equal(await W.Applier(cluster).Apply(W.Applied(1, 1), W.Target()), ConfigurationApplyResult.Reverted)
        assert.equal(cluster.Objects.has(W.ConfigMapPath), false)
        assert.equal(cluster.Objects.get(W.DeploymentPath)!.spec.template.metadata.annotations?.[W.Hash], undefined)
    })

    it('a refused write throws', async () =>
    {
        const W = ApplyWorld
        const cluster = W.Cluster()
        cluster.Refusals.set(`PATCH ${W.ConfigMapPath}`, 403)
        await assert.rejects(W.Applier(cluster).Apply(W.Applied(1, 7100), W.Target()))
    })
})

describe('KubeConfigurationApplier partial failures', () =>
{
    it('a refused hash patch after the ConfigMap write puts the previous ConfigMap back and throws', async () =>
    {
        const W = ApplyWorld
        const cluster = W.Cluster(W.Applied(1, 7100))
        cluster.Refusals.set(`PATCH ${W.DeploymentPath}`, 403)
        await assert.rejects(W.Applier(cluster).Apply(W.Applied(2, 7200), W.Target()))
        assert.equal(W.PortOf(cluster), 7100, 'the new file is not left for the next restart')
    })

    it('a failed ConfigMap restore does not keep the previous hash from going back on the Deployment', async () =>
    {
        const W = ApplyWorld
        const before = W.Applied(1, 7100)
        const cluster = new RefusingNthPatch(W.ConfigMapPath, 2)
        const seeded = W.Cluster(before)
        for (const [path, object] of seeded.Objects) cluster.Put(path, object)
        cluster.Readies = template => template.metadata?.annotations?.[W.Hash] !== W.Applied(2, 1).ContentHash()
        await assert.rejects(W.Applier(cluster).Apply(W.Applied(2, 1), W.Target()))
        assert.equal(cluster.Objects.get(W.DeploymentPath)!.spec.template.metadata.annotations[W.Hash], before.ContentHash(), 'the old template runs again')
    })
})

describe('RolloutWatch', () =>
{
    it('counts only updated pods as ready: a ready old pod beside an unready new one is not ready', () =>
    {
        const status = (replicas: number, updated: number, ready: number): Obj => ({ metadata: { generation: 2 }, spec: { replicas: 1 }, status: { observedGeneration: 2, replicas, updatedReplicas: updated, readyReplicas: ready } })
        assert.equal(RolloutWatch.IsReady(status(2, 1, 1)), false)
        assert.equal(RolloutWatch.IsReady(status(2, 1, 2)), true)
        assert.equal(RolloutWatch.IsReady(status(1, 1, 1)), true)
        assert.equal(RolloutWatch.IsReady({ ...status(1, 1, 1), status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, readyReplicas: 1 } }), false, 'the controller has not seen the new template')
    })

    it('polls until the deadline and answers not-ready', async () =>
    {
        const cluster = ApplyWorld.Cluster()
        cluster.Objects.get(ApplyWorld.DeploymentPath)!.status = { observedGeneration: 0 }
        cluster.Readies = () => false
        const clock = new FakeClock()
        const watch = new RolloutWatch(new KubeApiClient({ Send: async () => ({ status: 200, body: JSON.stringify({ metadata: { generation: 2 }, status: { observedGeneration: 1 } }) }) }), clock)
        assert.equal(await watch.Await(ApplyWorld.Target(), 10_000), RolloutState.NotReady)
        assert.ok(clock.Slept.every(ms => ms === RolloutWatch.PollMs))
    })
})
