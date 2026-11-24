import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AppliedConfiguration, AppliedConfigurationCodec, ApplyOutcome, ApplyRequest, ApplyTarget, ConfigurationSaveRequest, ConfigurationScope, InMemoryConfigurationRepository, type ApplyRecord } from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import { ConfigurationService } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { TenantAdminComponent } from '../../tenant-admin-component.js'
import { ConsoleSelfApply, SelfApplyOutcome } from '../console-self-apply.js'
import { KubeConfigurationApplier } from '../kube-configuration-applier.js'
import { RolloutWatch } from '../rollout-watch.js'
import { FakeClock, FakeCluster } from './fake-cluster.js'

type Obj = Record<string, any>

/** The console's own Deployment (recreated: its one pod is judged by its readiness probe) after its own apply. */
class ReadinessWorld
{
    public static readonly Hash = 'pragmatic-tech.ai/configuration-hash'
    public static readonly Deployment = 'pragmatic-tenant-admin-acme'
    public static readonly DeploymentPath = '/apis/apps/v1/namespaces/pragmatic-system/deployments/pragmatic-tenant-admin-acme'
    public static readonly ConfigMapPath = '/api/v1/namespaces/pragmatic-system/configmaps/pragmatic-config-pragmatic-tenant-admin'
    public static readonly Self = new ApplyTarget('h1', 'pragmatic-system', ReadinessWorld.Deployment)
    public static readonly Scope = new ConfigurationScope('acme', TenantAdminComponent.Name)

    public readonly Clock = new FakeClock()
    public readonly Cluster = new FakeCluster()
    public readonly Repository = new InMemoryConfigurationRepository()
    public readonly Good: AppliedConfiguration
    public readonly Next: AppliedConfiguration

    public constructor()
    {
        const d = TenantAdminComponent.Descriptor()
        this.Good = new AppliedConfiguration('acme', d.Name, 1, d.Version, d.ContentDigest(), { options: { core: { healthProbeMs: 30000 } } })
        this.Next = new AppliedConfiguration('acme', d.Name, 2, d.Version, d.ContentDigest(), { options: { core: { healthProbeMs: 45000 } } })
        this.Clock.Current = Date.now()
        this.Cluster.Clock = this.Clock
    }

    /** The cluster as the new console finds it: its template carries `running`, with what ran before (`Good`) kept beside it. */
    public async Started(running: AppliedConfiguration): Promise<{ self: ConsoleSelfApply; apply: ApplyRecord }>
    {
        const W = ReadinessWorld
        for (const document of [this.Good.Document, this.Next.Document])
        {
            const head = await this.Repository.Head(W.Scope)
            await this.Repository.Save(new ConfigurationSaveRequest(W.Scope, head === null ? 0 : head.Number, document, TenantAdminComponent.Descriptor(), 'a', ''))
        }
        const apply = await this.Repository.BeginApply(new ApplyRequest(W.Scope, 2, W.Self, 'a'))
        const map = AppliedConfigurationCodec.ToConfigMap(running, 'pragmatic-system') as unknown as Obj
        map.data['previous.json'] = AppliedConfigurationCodec.Encode(this.Good)
        map.data['previous-annotations.json'] = JSON.stringify(AppliedConfigurationCodec.ToConfigMap(this.Good, 'pragmatic-system').metadata.annotations)
        map.metadata.annotations['pragmatic-tech.ai/previous-configuration-hash'] = this.Good.ContentHash()
        this.Cluster.Recreated.add(W.DeploymentPath)
        this.Cluster.Put(W.DeploymentPath, {
            apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: W.Deployment, namespace: 'pragmatic-system' },
            spec: { replicas: 1, strategy: { type: 'Recreate' }, template: { metadata: { annotations: AppliedConfigurationCodec.PodTemplateAnnotations(running) }, spec: { containers: [{ name: 'tenant-admin', image: 'c:1' }] } } },
        })
        this.Cluster.Put(W.ConfigMapPath, map)
        return { self: new ConsoleSelfApply(new KubeApiClient(this.Cluster), W.Self, TenantAdminComponent.Name, this.Clock), apply }
    }

    public async Outcome(apply: ApplyRecord): Promise<[ApplyOutcome | undefined, string | undefined]>
    {
        const found = (await this.Repository.Applies(ReadinessWorld.Scope)).find(a => a.Id === apply.Id)
        return [found?.Outcome, found?.Detail]
    }

    public Template(): Obj
    {
        return this.Cluster.Objects.get(ReadinessWorld.DeploymentPath)!.spec.template
    }

    public Map(): Obj
    {
        return this.Cluster.Objects.get(ReadinessWorld.ConfigMapPath)!
    }
}

describe('ConsoleSelfApply readiness (the console keeps its previous version until the new one is proven)', () =>
{
    it('a console started by its own apply leaves it pending, with what ran before kept, until it has been ready for a while', async () =>
    {
        const world = new ReadinessWorld()
        const { self, apply } = await world.Started(world.Next)
        const awaiting = await self.Settle(world.Repository, 'acme')
        assert.equal(awaiting?.Id, apply.Id)
        assert.deepEqual(await world.Outcome(apply), [ApplyOutcome.Pending, ''], 'not Applied before readiness')
        assert.equal(typeof world.Map().data['previous.json'], 'string', 'what ran before is still kept')
        assert.equal(await self.AwaitReady(world.Repository, 'acme', apply), SelfApplyOutcome.Applied)
        assert.deepEqual((await world.Outcome(apply))[0], ApplyOutcome.Applied)
        assert.ok(world.Clock.Slept.reduce((a, b) => a + b, 0) >= ConsoleSelfApply.StableMs, 'applied only after StableMs of readiness')
        assert.equal(world.Map().data['previous.json'], undefined, 'forgotten once proven')
        assert.equal(world.Template().metadata.annotations[ReadinessWorld.Hash], world.Next.ContentHash())
    })

    it('a console that starts but never passes its probe (its listener is not the probed one) is put back, and its apply ends rollout-not-ready', async () =>
    {
        const world = new ReadinessWorld()
        const { self, apply } = await world.Started(world.Next)
        world.Cluster.Readies = template => template.metadata?.annotations?.[ReadinessWorld.Hash] !== world.Next.ContentHash()
        assert.ok(await self.Settle(world.Repository, 'acme'))
        assert.equal(await self.AwaitReady(world.Repository, 'acme', apply), SelfApplyOutcome.Reverted)
        assert.deepEqual(await world.Outcome(apply), [ApplyOutcome.Failed, ConfigurationService.RolloutNotReadyDetail])
        assert.equal(world.Template().metadata.annotations[ReadinessWorld.Hash], world.Good.ContentHash(), 'the last good template is back')
        assert.equal(AppliedConfigurationCodec.FromConfigMap(world.Map()).Version, 1, 'and its file')
        assert.ok(world.Clock.Now() - apply.RequestedAt.getTime() >= ConsoleSelfApply.ReadyTimeoutMs, 'not before the deadline')
    })

    it('a console ready only for a moment is not taken as proven', async () =>
    {
        const world = new ReadinessWorld()
        const { self, apply } = await world.Started(world.Next)
        const start = world.Clock.Now()
        world.Cluster.Readies = () => world.Clock.Now() - start < ConsoleSelfApply.StableMs / 2
        await self.Settle(world.Repository, 'acme')
        assert.equal(await self.AwaitReady(world.Repository, 'acme', apply), SelfApplyOutcome.Reverted)
        assert.deepEqual((await world.Outcome(apply))[0], ApplyOutcome.Failed)
    })

    it('a console restarted after the deadline of the apply that started it gets the restart grace, then puts back', async () =>
    {
        const world = new ReadinessWorld()
        const { self, apply } = await world.Started(world.Next)
        world.Clock.Current = apply.RequestedAt.getTime() + ConsoleSelfApply.ReadyTimeoutMs + 1
        const restarted = world.Clock.Now()
        world.Cluster.Readies = () => false
        await self.Settle(world.Repository, 'acme')
        assert.equal(await self.AwaitReady(world.Repository, 'acme', apply), SelfApplyOutcome.Reverted)
        assert.ok(world.Clock.Now() - restarted >= ConsoleSelfApply.RestartGraceMs, 'not before the grace')
        assert.equal(world.Template().metadata.annotations[ReadinessWorld.Hash], world.Good.ContentHash())
    })

    it('a good console restarted after the deadline (rescheduled during its proof) is still proven, not put back', async () =>
    {
        const world = new ReadinessWorld()
        const { self, apply } = await world.Started(world.Next)
        world.Clock.Current = apply.RequestedAt.getTime() + ConsoleSelfApply.ReadyTimeoutMs + 1
        await self.Settle(world.Repository, 'acme')
        assert.equal(await self.AwaitReady(world.Repository, 'acme', apply), SelfApplyOutcome.Applied)
        assert.equal(world.Template().metadata.annotations[ReadinessWorld.Hash], world.Next.ContentHash())
    })

    it('a console not ready by the deadline keeps putting back what ran before (Abandon), retrying a refused put-back', async () =>
    {
        const world = new ReadinessWorld()
        const { self, apply } = await world.Started(world.Next)
        await self.Settle(world.Repository, 'acme')
        world.Cluster.Refusals.set(`GET ${ReadinessWorld.ConfigMapPath}`, 503)
        assert.equal(await self.Abandon(world.Repository, 'acme', apply), true)
        assert.deepEqual(world.Clock.Slept, [ConsoleSelfApply.PollMs], 'the refused put-back was tried again')
        assert.equal(self.Proving, false)
        assert.deepEqual(await world.Outcome(apply), [ApplyOutcome.Failed, ConfigurationService.RolloutNotReadyDetail])
        assert.equal(world.Template().metadata.annotations[ReadinessWorld.Hash], world.Good.ContentHash())
    })

    it('a console whose listener does not bind tries the put-back once; refused, the apply stays pending and the restarted console puts back', async () =>
    {
        const world = new ReadinessWorld()
        const { self, apply } = await world.Started(world.Next)
        await self.Settle(world.Repository, 'acme')
        world.Cluster.Refusals.set(`GET ${ReadinessWorld.ConfigMapPath}`, 503)
        await assert.rejects(self.AbandonOnce(world.Repository, 'acme', apply))
        assert.deepEqual(world.Clock.Slept, [])
        assert.deepEqual(await world.Outcome(apply), [ApplyOutcome.Pending, ''], 'never failed before it is put back')
        assert.equal(typeof world.Map().data['previous.json'], 'string', 'what was kept is still there')
        // The process stops; the restarted console (same template, past the deadline) settles it again and puts back.
        const restarted = new ConsoleSelfApply(new KubeApiClient(world.Cluster), ReadinessWorld.Self, TenantAdminComponent.Name, world.Clock)
        world.Clock.Current = apply.RequestedAt.getTime() + ConsoleSelfApply.ReadyTimeoutMs + 1
        world.Cluster.Readies = () => false
        const awaiting = await restarted.Settle(world.Repository, 'acme')
        assert.equal(awaiting?.Id, apply.Id)
        assert.equal(await restarted.AwaitReady(world.Repository, 'acme', awaiting!), SelfApplyOutcome.Reverted)
        assert.deepEqual(await world.Outcome(apply), [ApplyOutcome.Failed, ConfigurationService.RolloutNotReadyDetail])
        assert.equal(world.Template().metadata.annotations[ReadinessWorld.Hash], world.Good.ContentHash())
    })

    it('says nothing was put back when nothing was kept', async () =>
    {
        const world = new ReadinessWorld()
        const { self, apply } = await world.Started(world.Next)
        await self.Settle(world.Repository, 'acme')
        delete world.Map().data['previous.json']
        assert.equal(await self.Abandon(world.Repository, 'acme', apply), false)
    })

    it('while it proves its own apply the console takes no new apply to itself', async () =>
    {
        const world = new ReadinessWorld()
        const { self, apply } = await world.Started(world.Next)
        const client = new KubeApiClient(world.Cluster)
        const applier = new KubeConfigurationApplier(client, new RolloutWatch(client, world.Clock), 0, self)
        assert.equal(applier.Busy(ReadinessWorld.Self), false)
        await self.Settle(world.Repository, 'acme')
        assert.equal(self.Proving, true)
        assert.equal(applier.Busy(ReadinessWorld.Self), true)
        assert.equal(applier.Busy(new ApplyTarget('h1', 'pragmatic-system', 'pragmatic-hive-agent-h1')), false, 'other targets are not held')
        await self.AwaitReady(world.Repository, 'acme', apply)
        assert.equal(applier.Busy(ReadinessWorld.Self), false)
    })

    it('a console that does not run the version of its own pending apply fails it at once and forgets what was kept', async () =>
    {
        const world = new ReadinessWorld()
        const { self, apply } = await world.Started(world.Good)
        assert.equal(await self.Settle(world.Repository, 'acme'), undefined)
        assert.deepEqual(await world.Outcome(apply), [ApplyOutcome.Failed, ConfigurationService.RolloutNotReadyDetail])
        assert.equal(world.Map().data['previous.json'], undefined)
    })

    it('stops watching when the console closes', async () =>
    {
        const world = new ReadinessWorld()
        const { self, apply } = await world.Started(world.Next)
        world.Cluster.Readies = () => false
        self.Stop()
        assert.equal(await self.AwaitReady(world.Repository, 'acme', apply), SelfApplyOutcome.Stopped)
        assert.deepEqual((await world.Outcome(apply))[0], ApplyOutcome.Pending)
    })
})
