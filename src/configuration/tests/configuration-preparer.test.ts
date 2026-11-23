import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ComponentDescriptorBuilder, SettingType, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import {
    AppliedConfiguration, AppliedConfigurationCodec, AppliedConfigurationEntries, ApplyTarget, ConfigurationPreparationStatus, ConfigurationSaveRequest, ConfigurationScope,
    InMemoryConfigurationRepository,
} from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeApiClient, KubeMethod } from '@pragmatic-tech-ai/pragmatic-kube'
import { ConfigurationPreparationOutcome, ConfigurationTarget, type IComponentDescriptorSource } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ConfigurationPreparer, PreparationResult } from '../configuration-preparer.js'
import { FixedTargets } from './configuration-fixture.js'
import { FakeCluster } from './fake-cluster.js'

type Obj = Record<string, any>

/** The staff realm's sign-in service: configured by hand for 0.2.0, about to run 0.2.4 (which no longer has a database URL). */
class PrepareWorld
{
    public static readonly Tenant = 'pragmatic-001'
    public static readonly Idp = 'pragmatic-tenant-idp'
    public static readonly Namespace = 'pragmatic-idp-pragmatic-001'
    public static readonly ConfigMapPath = '/api/v1/namespaces/pragmatic-idp-pragmatic-001/configmaps/pragmatic-config-pragmatic-tenant-idp'
    public static readonly DeploymentPath = '/apis/apps/v1/namespaces/pragmatic-idp-pragmatic-001/deployments/pragmatic-idp-pragmatic-001'
    public static readonly Document = { options: { google: { clientId: 'client-1.apps.googleusercontent.com', clientSecret: 'secret:realm/google-client-secret' }, local: { maxAttempts: 5 } } }

    public static Idp020(): ComponentDescriptor
    {
        return new ComponentDescriptorBuilder(PrepareWorld.Idp, '0.2.0')
            .Option('core', 'The service', o => o.Setting('databaseUrl', SettingType.String, s => s.Default('postgres://localhost/idp')))
            .Option('google', 'Google', o => o.Setting('clientId', SettingType.String, s => s.Required()).Setting('clientSecret', SettingType.String, s => s.Secret()))
            .Option('local', 'Local accounts', o => o.Setting('maxAttempts', SettingType.Integer, s => s.Default(5)))
            .Build()
    }

    public static Idp024(): ComponentDescriptor
    {
        return new ComponentDescriptorBuilder(PrepareWorld.Idp, '0.2.4')
            .Option('core', 'The service', o => o.Setting('trustedProxy', SettingType.Boolean, s => s.Default(false)))
            .Option('google', 'Google', o => o.Setting('clientId', SettingType.String, s => s.Required()).Setting('clientSecret', SettingType.String, s => s.Secret()))
            .Option('local', 'Local accounts', o => o.Setting('maxAttempts', SettingType.Integer, s => s.Default(5)))
            .Build()
    }

    /** What the hand-built ConfigMap holds: version 3, validated for 0.2.0. */
    public static Applied(document: object = PrepareWorld.Document, version = 3): AppliedConfiguration
    {
        const d = PrepareWorld.Idp020()
        return new AppliedConfiguration(PrepareWorld.Tenant, PrepareWorld.Idp, version, d.Version, d.ContentDigest(), document as never)
    }

    public static Cluster(applied: AppliedConfiguration | undefined = PrepareWorld.Applied()): FakeCluster
    {
        const W = PrepareWorld
        const cluster = new FakeCluster()
        cluster.Put(W.DeploymentPath, {
            apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: W.Namespace, namespace: W.Namespace },
            spec: { replicas: 1, template: { metadata: { annotations: applied === undefined ? {} : AppliedConfigurationCodec.PodTemplateAnnotations(applied) }, spec: { containers: [{ name: 'idp', image: 'idp:0.2.1' }] } } },
        })
        if (applied !== undefined)
        {
            const map = AppliedConfigurationCodec.ToConfigMap(applied, W.Namespace) as Obj
            map.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'] = '{}'
            cluster.Put(W.ConfigMapPath, map)
        }
        return cluster
    }

    public static Descriptors(current: ComponentDescriptor = PrepareWorld.Idp024()): IComponentDescriptorSource
    {
        return {
            Names: () => [PrepareWorld.Idp],
            Current: (component: string) => component === PrepareWorld.Idp ? current : undefined,
            For: async () => undefined,
        }
    }

    public static Target(): ConfigurationTarget
    {
        const W = PrepareWorld
        const running = W.Idp020()
        return new ConfigurationTarget(W.Namespace, new ApplyTarget('default-mvp-hive', W.Namespace, W.Namespace), running.ContentDigest(), running.Version)
    }

    public static Preparer(cluster: FakeCluster, repository = new InMemoryConfigurationRepository(), current?: ComponentDescriptor, lines: string[] = []): ConfigurationPreparer
    {
        const W = PrepareWorld
        return new ConfigurationPreparer(new KubeApiClient(cluster), repository, W.Descriptors(current), new FixedTargets(new Map([[W.Idp, [W.Target()]]])), line => lines.push(line))
    }

    public static Map(cluster: FakeCluster): Obj
    {
        return cluster.Objects.get(PrepareWorld.ConfigMapPath)!
    }

    public static Scope(): ConfigurationScope
    {
        return new ConfigurationScope(PrepareWorld.Tenant, PrepareWorld.Idp)
    }
}

describe('ConfigurationPreparer', () =>
{
    it('the live upgrade: a hand-applied version 3 for 0.2.0 is adopted, validated for 0.2.4 and prepared beside it, the running pod untouched', async () =>
    {
        const W = PrepareWorld
        const cluster = W.Cluster()
        const before = structuredClone(W.Map(cluster))
        const repository = new InMemoryConfigurationRepository()
        const lines: string[] = []
        const results = await W.Preparer(cluster, repository, undefined, lines).PrepareAll(W.Tenant)
        assert.deepEqual(results.map(r => r.Result), [PreparationResult.Prepared])
        const saved = await repository.Head(W.Scope())
        assert.equal(saved?.Number, 1, 'adopted as the repository next version')
        assert.equal(saved?.DescriptorDigest, W.Idp024().ContentDigest())
        assert.match(saved?.Comment ?? '', /applied version 3/)
        const map = W.Map(cluster)
        assert.equal(map.data['configuration.json'], before.data['configuration.json'], 'the old pod still reads its file')
        assert.equal(map.metadata.annotations['pragmatic-tech.ai/configuration-hash'], before.metadata.annotations['pragmatic-tech.ai/configuration-hash'])
        const entry = AppliedConfigurationEntries.Prepared(map).get(W.Idp024().ContentDigest())
        assert.equal(entry?.Version, 1)
        assert.equal(entry?.ComponentVersion, '0.2.4')
        assert.equal(entry?.Realm, W.Tenant)
        assert.ok(ConfigurationPreparationStatus.Of(map.metadata.annotations).IsPrepared(W.Idp024().ContentDigest()))
        assert.equal(cluster.Calls.some(c => c.method === KubeMethod.Patch && c.path.startsWith(W.DeploymentPath)), false, 'the Deployment is never patched: nothing rolls')
        assert.equal(JSON.stringify(cluster.Calls.filter(c => c.method === KubeMethod.Patch).map(c => c.body)).includes('last-applied-configuration'), false)
        assert.ok(lines.some(l => l.includes('prepared') && l.includes('0.2.4')))
    })

    it('a version the repository holds is re-validated as authored, not with the old descriptor defaults filled in', async () =>
    {
        const W = PrepareWorld
        const repository = new InMemoryConfigurationRepository()
        const authored = { options: { ...W.Document.options, core: {} } }
        const v1 = await repository.Save(new ConfigurationSaveRequest(W.Scope(), 0, authored, W.Idp020(), 'subject-admin', 'first'))
        // The applied form carries 0.2.0's database URL default, which 0.2.4 no longer declares.
        const applied = AppliedConfiguration.From(v1, W.Idp020())
        assert.ok(JSON.stringify(applied.Document).includes('databaseUrl'))
        const cluster = W.Cluster(applied)
        const [result] = await W.Preparer(cluster, repository).PrepareAll(W.Tenant)
        assert.equal(result.Result, PreparationResult.Prepared)
        assert.equal((await repository.Head(W.Scope()))?.Number, 2)
    })

    it('a document the new descriptor refuses is recorded refused naming the settings; nothing is saved or prepared', async () =>
    {
        const W = PrepareWorld
        const cluster = W.Cluster(W.Applied({ options: { ...W.Document.options, core: { databaseUrl: 'postgres://elsewhere/idp' } } }))
        const repository = new InMemoryConfigurationRepository()
        const [result] = await W.Preparer(cluster, repository).PrepareAll(W.Tenant)
        assert.equal(result.Result, PreparationResult.Refused)
        assert.deepEqual(result.Settings, ['core.databaseUrl'])
        assert.equal(await repository.Head(W.Scope()), null)
        const map = W.Map(cluster)
        assert.equal(AppliedConfigurationEntries.Prepared(map).size, 0)
        const refusal = ConfigurationPreparationStatus.Of(map.metadata.annotations).RefusalFor(W.Idp024().ContentDigest())
        assert.deepEqual(refusal?.Settings, ['core.databaseUrl'])
        assert.equal(refusal?.ComponentVersion, '0.2.4')
        assert.equal(JSON.stringify(map.metadata.annotations).includes('postgres://elsewhere'), false, 'a refusal names settings, never values')
    })

    it('a second start finds the prepared entry and saves nothing again', async () =>
    {
        const W = PrepareWorld
        const cluster = W.Cluster()
        const repository = new InMemoryConfigurationRepository()
        await W.Preparer(cluster, repository).PrepareAll(W.Tenant)
        const writes = cluster.Calls.filter(c => c.method === KubeMethod.Patch).length
        const [again] = await W.Preparer(cluster, repository).PrepareAll(W.Tenant)
        assert.equal(again.Result, PreparationResult.Prepared)
        assert.equal((await repository.Versions(W.Scope())).length, 1)
        assert.equal(cluster.Calls.filter(c => c.method === KubeMethod.Patch).length, writes, 'nothing written the second time')
    })

    it('a refusal is lifted once the document validates: the refused digest is then prepared', async () =>
    {
        const W = PrepareWorld
        const cluster = W.Cluster(W.Applied({ options: { ...W.Document.options, core: { databaseUrl: 'postgres://elsewhere/idp' } } }))
        const repository = new InMemoryConfigurationRepository()
        await W.Preparer(cluster, repository).PrepareAll(W.Tenant)
        // The admin applies a version the old pods accept and the new descriptor too (no database URL).
        const fixed = W.Applied(W.Document, 4)
        const map = W.Map(cluster)
        map.data['configuration.json'] = fixed.ToCanonicalJson()
        map.metadata.annotations['pragmatic-tech.ai/configuration-hash'] = fixed.ContentHash()
        const [result] = await W.Preparer(cluster, repository).PrepareAll(W.Tenant)
        assert.equal(result.Result, PreparationResult.Prepared)
        const status = ConfigurationPreparationStatus.Of(W.Map(cluster).metadata.annotations)
        assert.equal(status.RefusalFor(W.Idp024().ContentDigest()), undefined)
        assert.ok(status.IsPrepared(W.Idp024().ContentDigest()))
    })

    it('a target already on the release descriptor, or with no configuration, needs nothing', async () =>
    {
        const W = PrepareWorld
        const current = W.Cluster()
        const [same] = await W.Preparer(current, new InMemoryConfigurationRepository(), W.Idp020()).PrepareAll(W.Tenant)
        assert.equal(same.Result, PreparationResult.Current)
        const none = W.Cluster(undefined)
        none.Put(W.ConfigMapPath, { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'pragmatic-config-pragmatic-tenant-idp', namespace: W.Namespace } })
        const [empty] = await W.Preparer(none, new InMemoryConfigurationRepository()).PrepareAll(W.Tenant)
        assert.equal(empty.Result, PreparationResult.Unconfigured)
        for (const cluster of [current, none]) assert.equal(cluster.Calls.filter(c => c.method === KubeMethod.Patch).length, 0)
    })

    it('a configuration of another realm is left alone', async () =>
    {
        const W = PrepareWorld
        const d = W.Idp020()
        const cluster = W.Cluster(new AppliedConfiguration('other-realm', W.Idp, 3, d.Version, d.ContentDigest(), W.Document as never))
        const [result] = await W.Preparer(cluster).PrepareAll(W.Tenant)
        assert.equal(result.Result, PreparationResult.Skipped)
        assert.equal(cluster.Calls.filter(c => c.method === KubeMethod.Patch).length, 0)
    })

    it('one target the cluster refuses does not stop the others, and is reported failed', async () =>
    {
        const W = PrepareWorld
        const cluster = W.Cluster()
        cluster.Refusals.set(`PATCH ${W.ConfigMapPath}`, 403)
        const [result] = await W.Preparer(cluster).PrepareAll(W.Tenant)
        assert.equal(result.Result, PreparationResult.Failed)
    })

    it('lists what it recorded for each target: prepared and refused descriptors', async () =>
    {
        const W = PrepareWorld
        const cluster = W.Cluster()
        const preparer = W.Preparer(cluster)
        await preparer.PrepareAll(W.Tenant)
        const listed = await preparer.For(W.Idp, [W.Target()])
        assert.deepEqual(listed.map(p => [p.environment, p.componentVersion, p.outcome]), [[W.Namespace, '0.2.4', ConfigurationPreparationOutcome.Prepared]])
        const refused = W.Cluster(W.Applied({ options: { ...W.Document.options, core: { databaseUrl: 'x' } } }))
        const other = W.Preparer(refused)
        await other.PrepareAll(W.Tenant)
        const [row] = await other.For(W.Idp, [W.Target()])
        assert.equal(row.outcome, ConfigurationPreparationOutcome.Refused)
        assert.deepEqual(row.settings, ['core.databaseUrl'])
    })
})
