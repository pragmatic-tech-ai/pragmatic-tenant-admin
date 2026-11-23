import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppliedConfiguration, AppliedConfigurationCodec, AppliedConfigurationEntries, ConfigurationPreparationStatus, ApplyOutcome, ApplyRequest, ApplyTarget, ConfigurationSaveRequest, ConfigurationScope, ConfigurationStartError, ConfigurationStartReason, InMemoryConfigurationRepository, type IStartProcess } from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeApiClient, KubeMethod } from '@pragmatic-tech-ai/pragmatic-kube'
import { ConfigurationApplyResult, ConfigurationService } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { TenantAdminComponent } from '../../tenant-admin-component.js'
import { ConsoleSelfApply } from '../console-self-apply.js'
import { ConsoleStartFallback, type IConsoleRevert } from '../console-start-fallback.js'
import { KubeConfigurationApplier } from '../kube-configuration-applier.js'
import { RolloutWatch } from '../rollout-watch.js'
import { ConfigurationFixture } from './configuration-fixture.js'
import { FakeClock, FakeCluster } from './fake-cluster.js'

type Obj = Record<string, any>

class SelfWorld
{
    public static readonly Hash = 'pragmatic-tech.ai/configuration-hash'
    public static readonly Deployment = 'pragmatic-tenant-admin-acme'
    public static readonly DeploymentPath = '/apis/apps/v1/namespaces/pragmatic-system/deployments/pragmatic-tenant-admin-acme'
    public static readonly ConfigMapPath = '/api/v1/namespaces/pragmatic-system/configmaps/pragmatic-config-pragmatic-tenant-admin'
    public static readonly Self = new ApplyTarget('h1', 'pragmatic-system', SelfWorld.Deployment)

    public static Applied(version: number, port: number): AppliedConfiguration
    {
        const d = TenantAdminComponent.Descriptor()
        return new AppliedConfiguration('acme', d.Name, version, d.Version, d.ContentDigest(), { options: { core: { port } } })
    }

    public static Cluster(running: AppliedConfiguration): FakeCluster
    {
        const W = SelfWorld
        const cluster = new FakeCluster()
        cluster.Put(W.DeploymentPath, {
            apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: W.Deployment, namespace: 'pragmatic-system' },
            spec: { replicas: 1, template: { metadata: { annotations: AppliedConfigurationCodec.PodTemplateAnnotations(running) }, spec: { containers: [{ name: 'tenant-admin', image: 'c:1' }] } } },
        })
        cluster.Put(W.ConfigMapPath, AppliedConfigurationCodec.ToConfigMap(running, 'pragmatic-system') as unknown as Obj)
        return cluster
    }

    public static SelfApply(cluster: FakeCluster): ConsoleSelfApply
    {
        return new ConsoleSelfApply(new KubeApiClient(cluster), SelfWorld.Self, TenantAdminComponent.Name)
    }

    public static RunningHash(cluster: FakeCluster): string | undefined
    {
        return cluster.Objects.get(SelfWorld.DeploymentPath)!.spec.template.metadata.annotations?.[SelfWorld.Hash]
    }
}

class ExitRecorder implements IStartProcess
{
    public Code: number | undefined
    public Text = ''
    public readonly stderr = { write: (text: string): boolean => { this.Text += text; return true } }

    public exit(code: number): never
    {
        this.Code = code
        throw new Error('exit')
    }
}

describe('ConsoleSelfApply', () =>
{
    it('a configuration the console applies to itself keeps what ran before beside it; a refused start puts it back', async () =>
    {
        const W = SelfWorld
        const good = W.Applied(1, 7100)
        const bad = W.Applied(2, 1)
        const cluster = W.Cluster(good)
        const client = new KubeApiClient(cluster)
        // The console is recreated by its own apply: the watch never sees the end (here: the new pod never readies).
        cluster.Readies = template => template.metadata?.annotations?.[W.Hash] !== bad.ContentHash()
        const applier = new KubeConfigurationApplier(client, new RolloutWatch(client, new FakeClock()), 0, W.SelfApply(cluster))
        const written: Obj[] = []
        const send = cluster.Send.bind(cluster)
        cluster.Send = async (method, path, body, type) =>
        {
            if (path.startsWith(W.ConfigMapPath) && body !== undefined) written.push(JSON.parse(body))
            return send(method, path, body, type)
        }
        await applier.Apply(bad, W.Self)
        const first = written[0]
        assert.equal(first.data['previous.json'], AppliedConfigurationCodec.Encode(good), 'what ran before is kept beside the new file')
        assert.equal(first.metadata.annotations['pragmatic-tech.ai/previous-configuration-hash'], good.ContentHash())

        // The new console's start refuses: it puts back what ran before.
        const fresh = W.Cluster(good)
        fresh.Objects.set(W.ConfigMapPath, structuredClone(first))
        fresh.Objects.get(W.DeploymentPath)!.spec.template.metadata.annotations[W.Hash] = bad.ContentHash()
        assert.equal(await W.SelfApply(fresh).Revert(), true)
        const restored = fresh.Objects.get(W.ConfigMapPath)!
        assert.equal(AppliedConfigurationCodec.FromConfigMap(restored).Version, 1, 'the previous file and its annotations read back')
        assert.equal(restored.metadata.annotations['pragmatic-tech.ai/configuration-hash'], good.ContentHash())
        assert.equal(W.RunningHash(fresh), good.ContentHash())
        const order = fresh.Calls.filter(c => c.method === KubeMethod.Patch).map(c => c.path.split('?')[0])
        assert.deepEqual(order, [W.DeploymentPath, W.ConfigMapPath], 'the template first, then the file')
    })

    it('a console that runs without anything to put back does nothing', async () =>
    {
        const cluster = SelfWorld.Cluster(SelfWorld.Applied(1, 7100))
        assert.equal(await SelfWorld.SelfApply(cluster).Revert(), false)
    })

    it('settles its own pending apply: applied when it runs that version, else rollout-not-ready', async () =>
    {
        const W = SelfWorld
        const repository = new InMemoryConfigurationRepository()
        const scope = new ConfigurationScope('acme', TenantAdminComponent.Name)
        const d = TenantAdminComponent.Descriptor()
        for (const source of ['cert-manager', 'development'])
        {
            const head = await repository.Head(scope)
            await repository.Save(new ConfigurationSaveRequest(scope, head === null ? 0 : head.Number, { options: { ingressTls: { source } } }, d, 'a', ''))
        }
        const two = await repository.BeginApply(new ApplyRequest(scope, 2, W.Self, 'a'))
        await W.SelfApply(W.Cluster(W.Applied(2, 7200))).Settle(repository, 'acme')
        assert.equal((await repository.Applies(scope)).find(a => a.Id === two.Id)?.Outcome, ApplyOutcome.Applied)
        const again = await repository.BeginApply(new ApplyRequest(scope, 2, W.Self, 'a'))
        await W.SelfApply(W.Cluster(W.Applied(1, 7100))).Settle(repository, 'acme')
        const settled = (await repository.Applies(scope)).find(a => a.Id === again.Id)
        assert.deepEqual([settled?.Outcome, settled?.Detail], [ApplyOutcome.Failed, ConfigurationService.RolloutNotReadyDetail])
    })

    it('settles only the newest pending apply by what runs; older ones are superseded; what was kept is forgotten', async () =>
    {
        const W = SelfWorld
        const repository = new InMemoryConfigurationRepository()
        const scope = new ConfigurationScope('acme', TenantAdminComponent.Name)
        const d = TenantAdminComponent.Descriptor()
        for (const source of ['cert-manager', 'development'])
        {
            const head = await repository.Head(scope)
            await repository.Save(new ConfigurationSaveRequest(scope, head === null ? 0 : head.Number, { options: { ingressTls: { source } } }, d, 'a', ''))
        }
        const older = await repository.BeginApply(new ApplyRequest(scope, 1, W.Self, 'a'))
        const newest = await repository.BeginApply(new ApplyRequest(scope, 2, W.Self, 'a'))
        const cluster = W.Cluster(W.Applied(2, 7200))
        const map = cluster.Objects.get(W.ConfigMapPath)!
        map.data['previous.json'] = 'x'
        map.metadata.annotations['pragmatic-tech.ai/previous-configuration-hash'] = 'sha256:old'
        await W.SelfApply(cluster).Settle(repository, 'acme')
        const applies = await repository.Applies(scope)
        assert.deepEqual([applies.find(a => a.Id === older.Id)?.Detail, applies.find(a => a.Id === newest.Id)?.Outcome], [ConsoleSelfApply.SupersededDetail, ApplyOutcome.Applied])
        const after = cluster.Objects.get(W.ConfigMapPath)!
        assert.equal(after.data['previous.json'], undefined, 'a later, unrelated start failure has nothing to revert to')
        assert.equal(after.metadata.annotations['pragmatic-tech.ai/previous-configuration-hash'], undefined)
        assert.equal(await W.SelfApply(cluster).Revert(), false)
    })
})

class FailingCompletion extends InMemoryConfigurationRepository
{
    public override async CompleteApply(...args: Parameters<InMemoryConfigurationRepository['CompleteApply']>): Promise<never>
    {
        throw new Error('the repository is down')
    }
}

describe('ConsoleSelfApply settling under failure and interruption', () =>
{
    it('forgets what it kept even when completing the apply fails, so a later refusal cannot undo a good apply', async () =>
    {
        const W = SelfWorld
        const repository = new FailingCompletion()
        const scope = new ConfigurationScope('acme', TenantAdminComponent.Name)
        await repository.Save(new ConfigurationSaveRequest(scope, 0, { options: { ingressTls: { source: 'development' } } }, TenantAdminComponent.Descriptor(), 'a', ''))
        await repository.BeginApply(new ApplyRequest(scope, 1, W.Self, 'a'))
        const cluster = W.Cluster(W.Applied(1, 7100))
        cluster.Objects.get(W.ConfigMapPath)!.data['previous.json'] = 'x'
        await assert.rejects(W.SelfApply(cluster).Settle(repository, 'acme'), /repository is down/)
        assert.equal(cluster.Objects.get(W.ConfigMapPath)!.data['previous.json'], undefined)
        assert.equal(await W.SelfApply(cluster).Revert(), false)
    })

    it('an apply to another component that the restart interrupted is failed as interrupted, never left pending; the console own is left to Settle', async () =>
    {
        const W = SelfWorld
        const repository = new InMemoryConfigurationRepository()
        const agent = new ConfigurationScope('acme', 'pragmatic-hive-agent')
        const own = new ConfigurationScope('acme', TenantAdminComponent.Name)
        await repository.Save(new ConfigurationSaveRequest(agent, 0, { options: { core: { pollIntervalMs: 15000 } } }, ConfigurationFixture.Agent010(), 'a', ''))
        await repository.Save(new ConfigurationSaveRequest(own, 0, { options: { ingressTls: { source: 'development' } } }, TenantAdminComponent.Descriptor(), 'a', ''))
        const other = await repository.BeginApply(new ApplyRequest(agent, 1, new ApplyTarget('h1', 'pragmatic-system', 'pragmatic-hive-agent-h1'), 'a'))
        const mine = await repository.BeginApply(new ApplyRequest(own, 1, W.Self, 'a'))
        await W.SelfApply(W.Cluster(W.Applied(1, 7100))).SettleInterrupted(repository, 'acme', ['pragmatic-hive-agent', TenantAdminComponent.Name])
        const settled = (await repository.Applies(agent)).find(a => a.Id === other.Id)
        assert.deepEqual([settled?.Outcome, settled?.Detail], [ApplyOutcome.Failed, ConsoleSelfApply.InterruptedDetail])
        assert.equal((await repository.Applies(own)).find(a => a.Id === mine.Id)?.Outcome, ApplyOutcome.Pending)
    })
})

describe('ConsoleStartFallback', () =>
{
    class RecordingRevert implements IConsoleRevert
    {
        public Calls = 0

        public constructor(private readonly answer: boolean)
        {
        }

        public async Revert(): Promise<boolean>
        {
            this.Calls += 1
            return this.answer
        }
    }

    it('starts with what the readers read when the configuration is fine, putting nothing back', async () =>
    {
        const revert = new RecordingRevert(true)
        const value = await ConsoleStartFallback.Start(TenantAdminComponent.Declaration, { PRAGMATIC_CONFIGURATION_FILE: '/no/such/file.json' }, () => 42, revert, new ExitRecorder())
        assert.deepEqual([value, revert.Calls], [42, 0])
    })

    it('a start the configuration refuses puts back what ran before, then exits 78 saying so', async () =>
    {
        const revert = new RecordingRevert(true)
        const process = new ExitRecorder()
        await assert.rejects(ConsoleStartFallback.Start(TenantAdminComponent.Declaration, {}, () => { throw new ConfigurationStartError(ConfigurationStartReason.Invalid, 'bad port') }, revert, process), /exit/)
        assert.deepEqual([process.Code, revert.Calls], [78, 1])
        assert.match(process.Text, /bad port: the previous configuration of the console was put back/)
    })

    it('a reader failure with nothing to put back is the failure it was', async () =>
    {
        await assert.rejects(ConsoleStartFallback.Start(TenantAdminComponent.Declaration, {}, () => { throw new Error('missing PRAGMATIC_X') }, new RecordingRevert(false), new ExitRecorder()), /missing PRAGMATIC_X/)
    })

    it('finds its Deployment from the name its manifest renders', () =>
    {
        assert.equal(ConsoleStartFallback.DeploymentOf({ PRAGMATIC_TENANT_ADMIN_DEPLOYMENT: 'pragmatic-tenant-admin-' + 'a'.repeat(30) }), 'pragmatic-tenant-admin-' + 'a'.repeat(30))
        assert.equal(ConsoleStartFallback.DeploymentOf({}), undefined)
        assert.equal(ConsoleStartFallback.DeploymentOf({ PRAGMATIC_TENANT_ADMIN_DEPLOYMENT: 'Not A Name' }), undefined)
        assert.equal(ConsoleStartFallback.InCluster({ PRAGMATIC_TENANT_ADMIN_DEPLOYMENT: 'x' }), undefined, 'outside a pod there is nothing to put back')
        assert.equal(ConfigurationApplyResult.Reverted, 'reverted')
    })
})

describe('ConsoleSelfApply and prepared entries', () =>
{
    it('putting back what ran before keeps the entries prepared for the next release', async () =>
    {
        const W = SelfWorld
        const good = W.Applied(1, 7100)
        const bad = W.Applied(2, 1)
        const cluster = W.Cluster(good)
        const client = new KubeApiClient(cluster)
        const nextDigest = `sha256:${'f'.repeat(64)}`
        const next = new AppliedConfiguration('acme', good.Component, 3, '9.9.9', nextDigest, { options: {} })
        cluster.Objects.set(W.ConfigMapPath, AppliedConfigurationEntries.With(cluster.Objects.get(W.ConfigMapPath) as never, next) as Obj)
        cluster.Readies = () => false
        const applier = new KubeConfigurationApplier(client, new RolloutWatch(client, new FakeClock()), 0, W.SelfApply(cluster))
        await applier.Apply(bad, W.Self).catch(() => undefined)
        // The new console refuses its start: the revert keeps the prepared entry and its mark.
        const map = cluster.Objects.get(W.ConfigMapPath)!
        map.data['configuration.json'] = bad.ToCanonicalJson()
        map.data['previous.json'] = good.ToCanonicalJson()
        assert.equal(await W.SelfApply(cluster).Revert(), true)
        const restored = cluster.Objects.get(W.ConfigMapPath)!
        assert.equal(AppliedConfigurationCodec.FromConfigMap(restored).Version, 1)
        assert.deepEqual([...AppliedConfigurationEntries.Prepared(restored).keys()], [nextDigest])
        assert.ok(ConfigurationPreparationStatus.Of(restored.metadata.annotations).IsPrepared(nextDigest))
    })

    it('the console starts on a configuration applied for its previous descriptor that validates against its own', async () =>
    {
        const folder = await mkdtemp(join(tmpdir(), 'console-revalidate-'))
        try
        {
            const own = TenantAdminComponent.Descriptor()
            const applied = new AppliedConfiguration('acme', own.Name, 3, '0.0.1', `sha256:${'a'.repeat(64)}`, { options: { core: { port: 7443 } } })
            const path = join(folder, 'configuration.json')
            await writeFile(path, applied.ToCanonicalJson())
            const env: NodeJS.ProcessEnv = { PRAGMATIC_CONFIGURATION_FILE: path }
            const port = await ConsoleStartFallback.Start(TenantAdminComponent.Declaration, env, e => e.PRAGMATIC_TENANT_ADMIN_PORT, undefined, new ExitRecorder())
            assert.equal(port, '7443', 'the re-validated document was overlaid')
        }
        finally
        {
            await rm(folder, { recursive: true, force: true })
        }
    })
})
