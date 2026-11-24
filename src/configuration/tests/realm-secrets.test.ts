import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import { InMemoryConfigurationRepository, RealmSecretWriter, type AppliedConfiguration, type ApplyTarget } from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import { CloudSecretManagerSecretStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { ConfigurationApplyResult, ConfigurationSecretNameError, ConfigurationService, type IComponentDescriptorSource, type IConfigurationApplier } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { InterimSecretMigration, InterimSecretMigrationOutcome } from '../interim-secret-migration.js'
import { RealmComponentSecretWriter } from '../realm-component-secret-writer.js'
import { ConfigurationFixture, FixedTargets } from './configuration-fixture.js'
import { FakeCluster } from './fake-cluster.js'

/** The agent's descriptor only. */
class AgentDescriptors implements IComponentDescriptorSource
{
    public Names(): readonly string[]
    {
        return [ConfigurationFixture.Agent]
    }

    public Current(): ComponentDescriptor
    {
        return ConfigurationFixture.Agent010()
    }

    public async For(): Promise<ComponentDescriptor>
    {
        return ConfigurationFixture.Agent010()
    }
}

/** Applies by recording what it was given (and when, against the cluster's calls); `Reverts` fails those targets' rolls. */
class RecordingApplier implements IConfigurationApplier
{
    public readonly Applied: { Document: unknown, Namespace: string, CallsBefore: number }[] = []
    public readonly Reverts = new Set<string>()

    public constructor(private readonly cluster: FakeCluster)
    {
    }

    public get Available(): boolean
    {
        return true
    }

    public async Apply(applied: AppliedConfiguration, target: ApplyTarget): Promise<ConfigurationApplyResult>
    {
        this.Applied.push({ Document: applied.Document, Namespace: target.Namespace, CallsBefore: this.cluster.Calls.length })
        return this.Reverts.has(target.Namespace) ? ConfigurationApplyResult.Reverted : ConfigurationApplyResult.Applied
    }
}

class Scene
{
    public static readonly Tenant = ConfigurationFixture.Tenant
    public static readonly Agent = ConfigurationFixture.Agent

    public readonly Cluster = new FakeCluster()
    public readonly Home = new CloudSecretManagerSecretStore()
    public readonly Applier = new RecordingApplier(this.Cluster)
    public readonly Targets = new FixedTargets(new Map([[Scene.Agent, [
        ConfigurationFixture.Target('dev1', 'pragmatic-env-dev1', 'agent', ConfigurationFixture.Agent010()),
        ConfigurationFixture.Target('dev2', 'pragmatic-env-dev2', 'agent', ConfigurationFixture.Agent010()),
    ]]]))
    public readonly Writer = new RealmSecretWriter(this.Home)
    public readonly Service = new ConfigurationService(new InMemoryConfigurationRepository(), new AgentDescriptors(), this.Targets, this.Applier, new RealmComponentSecretWriter(this.Writer))

    public static SecretPath(namespace: string): string
    {
        return `/api/v1/namespaces/${namespace}/secrets/pragmatic-secrets-${Scene.Agent}`
    }

    public Interim(namespace: string, data: Record<string, string>): void
    {
        const encoded = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Buffer.from(value).toString('base64')]))
        this.Cluster.Put(Scene.SecretPath(namespace), { apiVersion: 'v1', kind: 'Secret', metadata: { name: `pragmatic-secrets-${Scene.Agent}`, namespace }, data: encoded })
    }

    /** Saves the agent's configuration referring to `secret:file/<token>` and applies it to both targets. */
    public async AppliedWithFileToken(): Promise<number>
    {
        const saved = await this.Service.Save(Scene.Tenant, Scene.Agent, 0, { options: { core: { pollIntervalMs: 5000, token: 'secret:file/agent-token' } } }, ConfigurationFixture.Admin, 'interim')
        await this.Service.Apply(Scene.Tenant, Scene.Agent, saved.version, 'dev1', ConfigurationFixture.Admin)
        await this.Service.Apply(Scene.Tenant, Scene.Agent, saved.version, 'dev2', ConfigurationFixture.Admin)
        this.Applier.Applied.length = 0
        return saved.version
    }

    public Migration(): InterimSecretMigration
    {
        return new InterimSecretMigration(this.Service, new KubeApiClient(this.Cluster), this.Writer)
    }

    public Deleted(namespace: string): number
    {
        return this.Cluster.Calls.findIndex(call => call.method === 'DELETE' && call.path === Scene.SecretPath(namespace))
    }
}

describe('secrets in the realm secrets home', () =>
{
    it('an entered secret lands in the realm home and the configuration holds a reference', async () =>
    {
        const scene = new Scene()
        const answer = await scene.Service.PutSecret(Scene.Tenant, Scene.Agent, 'dev1', 'agent-token', 'entered-value')
        assert.deepEqual(answer, { name: 'agent-token', reference: 'secret:realm/agent-token' })
        assert.equal(await scene.Home.Get('agent-token'), 'entered-value')
        assert.equal(scene.Cluster.Calls.length, 0, 'nothing is written into the cluster')
        await assert.rejects(scene.Service.PutSecret(Scene.Tenant, Scene.Agent, 'dev1', 'Agent.Token', 'v'), ConfigurationSecretNameError)
        const saved = await scene.Service.Save(Scene.Tenant, Scene.Agent, 0, { options: { core: { token: answer.reference } } }, ConfigurationFixture.Admin, 'realm')
        assert.equal(saved.version, 1)
    })

    it('the interim Kubernetes Secret is migrated, the version re-applied and only then deleted', async () =>
    {
        const scene = new Scene()
        const applied = await scene.AppliedWithFileToken()
        scene.Interim('pragmatic-env-dev1', { 'agent-token': 'token-value' })
        scene.Interim('pragmatic-env-dev2', { 'agent-token': 'token-value' })
        const [report] = await scene.Migration().Run(Scene.Tenant)
        assert.equal(report!.Outcome, InterimSecretMigrationOutcome.Moved)
        assert.deepEqual(report!.Keys, ['agent-token'])
        assert.equal(await scene.Home.Get('agent-token'), 'token-value')
        assert.equal(scene.Applier.Applied.length, 2)
        for (const apply of scene.Applier.Applied)
        {
            assert.deepEqual((apply.Document as { options: { core: { token: string } } }).options.core.token, 'secret:realm/agent-token')
            const deleted = scene.Deleted(apply.Namespace)
            assert.ok(deleted >= apply.CallsBefore, `the Secret of ${apply.Namespace} is deleted only after its apply`)
        }
        assert.equal(scene.Cluster.Objects.has(Scene.SecretPath('pragmatic-env-dev1')), false)
        const component = await scene.Service.Component(Scene.Tenant, Scene.Agent)
        assert.ok(component.versions.length > applied)
        // Idempotent: nothing is left to move.
        const [again] = await scene.Migration().Run(Scene.Tenant)
        assert.equal(again!.Outcome, InterimSecretMigrationOutcome.Nothing)
    })

    it('a failed apply keeps the interim Secret', async () =>
    {
        const scene = new Scene()
        await scene.AppliedWithFileToken()
        scene.Interim('pragmatic-env-dev1', { 'agent-token': 'token-value' })
        scene.Interim('pragmatic-env-dev2', { 'agent-token': 'token-value' })
        scene.Applier.Reverts.add('pragmatic-env-dev2')
        const [report] = await scene.Migration().Run(Scene.Tenant)
        assert.equal(report!.Outcome, InterimSecretMigrationOutcome.ApplyFailed)
        assert.equal(scene.Cluster.Objects.has(Scene.SecretPath('pragmatic-env-dev1')), false, 'the applied target loses its Secret')
        assert.equal(scene.Cluster.Objects.has(Scene.SecretPath('pragmatic-env-dev2')), true, 'the failed one keeps it')
        // The next start resumes: dev2 applies this time and loses its Secret.
        scene.Applier.Reverts.clear()
        const [resumed] = await scene.Migration().Run(Scene.Tenant)
        assert.equal(resumed!.Outcome, InterimSecretMigrationOutcome.Moved)
        assert.equal(scene.Cluster.Objects.has(Scene.SecretPath('pragmatic-env-dev2')), false)
    })

    it('different values under one key, or a key that is no realm secret name, move nothing', async () =>
    {
        const conflict = new Scene()
        await conflict.AppliedWithFileToken()
        conflict.Interim('pragmatic-env-dev1', { 'agent-token': 'one' })
        conflict.Interim('pragmatic-env-dev2', { 'agent-token': 'two' })
        const [refused] = await conflict.Migration().Run(Scene.Tenant)
        assert.equal(refused!.Outcome, InterimSecretMigrationOutcome.Conflict)
        assert.equal(await conflict.Home.Get('agent-token'), null)
        assert.equal(conflict.Applier.Applied.length, 0)
        assert.equal(conflict.Cluster.Objects.size, 2)
        const badName = new Scene()
        badName.Interim('pragmatic-env-dev1', { 'Agent.Token': 'v' })
        const [named] = await badName.Migration().Run(Scene.Tenant)
        assert.equal(named!.Outcome, InterimSecretMigrationOutcome.BadName)
        assert.equal(badName.Cluster.Objects.size, 1)
    })

    it('a draft head keeps its edits, its references rewritten', async () =>
    {
        const scene = new Scene()
        const applied = await scene.AppliedWithFileToken()
        await scene.Service.Save(Scene.Tenant, Scene.Agent, applied, { options: { core: { pollIntervalMs: 9000, token: 'secret:file/agent-token' } } }, ConfigurationFixture.Admin, 'draft')
        scene.Interim('pragmatic-env-dev1', { 'agent-token': 'v' })
        await scene.Migration().Run(Scene.Tenant)
        const versions = (await scene.Service.Component(Scene.Tenant, Scene.Agent)).versions
        const head = await scene.Service.Version(Scene.Tenant, Scene.Agent, versions.at(-1)!.version)
        assert.deepEqual(head.document, { options: { core: { pollIntervalMs: 9000, token: 'secret:realm/agent-token' } } })
    })

    it('rewrites only unpinned file references to the moved keys', () =>
    {
        const document = { a: 'secret:file/k', b: ['secret:file/other', 'secret:file/k@2'], c: { d: 'secret:realm/k', e: 3 } }
        assert.deepEqual(InterimSecretMigration.Rewritten(document, ['k']), { a: 'secret:realm/k', b: ['secret:file/other', 'secret:file/k@2'], c: { d: 'secret:realm/k', e: 3 } })
    })
})
