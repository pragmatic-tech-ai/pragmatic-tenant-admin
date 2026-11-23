import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ComponentDescriptorBuilder, SettingType, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import {
    AppliedConfiguration, AppliedConfigurationCodec, AppliedConfigurationEntries, ApplyOutcome, ApplyRequest, ApplyTarget, ConfigurationPreparationStatus, ConfigurationSaveRequest,
    ConfigurationScope, InMemoryConfigurationRepository,
} from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeApiClient, KubeMethod } from '@pragmatic-tech-ai/pragmatic-kube'
import { ConfigurationPreparationOutcome, ConfigurationTarget, type IComponentDescriptorSource } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ConfigMapWriteLock } from '../config-map-write-lock.js'
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

    public static Descriptors(current: ComponentDescriptor = PrepareWorld.Idp024(), known: readonly ComponentDescriptor[] = []): IComponentDescriptorSource
    {
        return {
            Names: () => [PrepareWorld.Idp],
            Current: (component: string) => component === PrepareWorld.Idp ? current : undefined,
            For: async (_component: string, version: string) => known.find(d => d.Version === version),
        }
    }

    public static Target(): ConfigurationTarget
    {
        const W = PrepareWorld
        const running = W.Idp020()
        return new ConfigurationTarget(W.Namespace, new ApplyTarget('default-mvp-hive', W.Namespace, W.Namespace), running.ContentDigest(), running.Version)
    }

    public static Preparer(cluster: FakeCluster, repository = new InMemoryConfigurationRepository(), current?: ComponentDescriptor, lines: string[] = [], known: readonly ComponentDescriptor[] = []): ConfigurationPreparer
    {
        const W = PrepareWorld
        return new ConfigurationPreparer(new KubeApiClient(cluster), repository, W.Descriptors(current, known), new FixedTargets(new Map([[W.Idp, [W.Target()]]])), new ConfigMapWriteLock(), line => lines.push(line))
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
        const [result] = await W.Preparer(cluster, repository, undefined, [], [W.Idp020()]).PrepareAll(W.Tenant)
        assert.equal(result.Result, PreparationResult.Prepared)
        assert.equal((await repository.Head(W.Scope()))?.Number, 2)
        // Without the old descriptor, the target's last apply of that version vouches for the repository's content.
        const viaRecord = new InMemoryConfigurationRepository()
        const r1 = await viaRecord.Save(new ConfigurationSaveRequest(W.Scope(), 0, authored, W.Idp020(), 'subject-admin', 'first'))
        const pending = await viaRecord.BeginApply(new ApplyRequest(W.Scope(), r1.Number, W.Target().Target, 'subject-admin'))
        await viaRecord.CompleteApply(W.Scope(), pending.Id, ApplyOutcome.Applied, '')
        const [recorded] = await W.Preparer(W.Cluster(AppliedConfiguration.From(r1, W.Idp020())), viaRecord).PrepareAll(W.Tenant)
        assert.equal(recorded.Result, PreparationResult.Prepared)
    })

    it('a repository version of the same number but other content is not taken for the applied one', async () =>
    {
        const W = PrepareWorld
        const repository = new InMemoryConfigurationRepository()
        // The repository's version 1 sets 9 attempts; the hand-applied "version 1" sets 5.
        await repository.Save(new ConfigurationSaveRequest(W.Scope(), 0, { options: { ...W.Document.options, local: { maxAttempts: 9 } } }, W.Idp020(), 'subject-admin', 'other'))
        const cluster = W.Cluster(W.Applied(W.Document, 1))
        await W.Preparer(cluster, repository, undefined, [], [W.Idp020()]).PrepareAll(W.Tenant)
        const entry = AppliedConfigurationEntries.Prepared(W.Map(cluster)).get(W.Idp024().ContentDigest())
        assert.equal((entry?.Document as any).options.local.maxAttempts, 5)
    })

    it('with the old descriptor known, its filled-in defaults for a retired setting are left behind, not refused', async () =>
    {
        const W = PrepareWorld
        const d = W.Idp020()
        const filled = { options: { ...W.Document.options, core: { databaseUrl: 'postgres://localhost/idp' } } }
        const cluster = W.Cluster(new AppliedConfiguration(W.Tenant, W.Idp, 3, d.Version, d.ContentDigest(), filled as never))
        const [known] = await W.Preparer(cluster, new InMemoryConfigurationRepository(), undefined, [], [d]).PrepareAll(W.Tenant)
        assert.equal(known.Result, PreparationResult.Prepared)
        const [unknown] = await W.Preparer(W.Cluster(new AppliedConfiguration(W.Tenant, W.Idp, 3, d.Version, d.ContentDigest(), filled as never))).PrepareAll(W.Tenant)
        assert.equal(unknown.Result, PreparationResult.Refused, 'without the old descriptor a value cannot be told from a default')
    })

    it('an apply since the preparation makes it stale: listed nowhere, prepared again from the new file', async () =>
    {
        const W = PrepareWorld
        const cluster = W.Cluster()
        const repository = new InMemoryConfigurationRepository()
        const preparer = W.Preparer(cluster, repository)
        await preparer.PrepareAll(W.Tenant)
        const next = W.Applied({ options: { ...W.Document.options, local: { maxAttempts: 8 } } }, 5)
        const map = W.Map(cluster)
        map.data['configuration.json'] = next.ToCanonicalJson()
        map.metadata.annotations['pragmatic-tech.ai/configuration-hash'] = next.ContentHash()
        assert.equal(ConfigurationPreparationStatus.Of(map.metadata.annotations).Holds(next.ContentHash()), false)
        assert.deepEqual(await preparer.For(W.Idp, [W.Target()]), [], 'a stale status is not shown as ready')
        await preparer.PrepareAll(W.Tenant)
        const entry = AppliedConfigurationEntries.Prepared(W.Map(cluster)).get(W.Idp024().ContentDigest())
        assert.equal((entry?.Document as any).options.local.maxAttempts, 8, 'derived from the file applied now')
        assert.ok(ConfigurationPreparationStatus.Of(W.Map(cluster).metadata.annotations).Holds(next.ContentHash()))
    })

    it('a release older than the applied component version prepares nothing back', async () =>
    {
        const W = PrepareWorld
        const older = new ComponentDescriptorBuilder(W.Idp, '0.1.9').Option('local', 'Local accounts', o => o.Setting('maxAttempts', SettingType.Integer, s => s.Default(5))).Build()
        const cluster = W.Cluster()
        const [result] = await W.Preparer(cluster, new InMemoryConfigurationRepository(), older).PrepareAll(W.Tenant)
        assert.equal(result.Result, PreparationResult.Ahead)
        assert.equal(cluster.Calls.filter(c => c.method === KubeMethod.Patch).length, 0)
    })

    it('entries for descriptors nobody runs or rolls to are dropped; the one the target runs is kept and not listed', async () =>
    {
        const W = PrepareWorld
        const cluster = W.Cluster()
        const map = W.Map(cluster)
        const gone = new AppliedConfiguration(W.Tenant, W.Idp, 2, '0.1.0', `sha256:${'9'.repeat(64)}`, W.Document as never)
        cluster.Objects.set(W.ConfigMapPath, AppliedConfigurationEntries.With(map as never, gone) as never)
        const preparer = W.Preparer(cluster)
        await preparer.PrepareAll(W.Tenant)
        assert.deepEqual([...AppliedConfigurationEntries.Prepared(W.Map(cluster)).keys()], [W.Idp024().ContentDigest()])
        const running = new ConfigurationTarget(W.Namespace, W.Target().Target, W.Idp024().ContentDigest(), '0.2.4')
        assert.deepEqual(await preparer.For(W.Idp, [running]), [], 'the target already runs that descriptor')
    })

    it('never drops an entry when what the target runs is unknown (after an apply, or an unmapped image)', async () =>
    {
        const W = PrepareWorld
        const cluster = W.Cluster()
        const map = W.Map(cluster)
        const running = new AppliedConfiguration(W.Tenant, W.Idp, 2, '0.2.1', `sha256:${'8'.repeat(64)}`, W.Document as never)
        cluster.Objects.set(W.ConfigMapPath, AppliedConfigurationEntries.With(map as never, running) as never)
        const unknown = new ConfigurationTarget(W.Namespace, W.Target().Target, undefined, undefined)
        const preparer = new ConfigurationPreparer(new KubeApiClient(cluster), new InMemoryConfigurationRepository(), W.Descriptors(), new FixedTargets(new Map([[W.Idp, [unknown]]])))
        await preparer.PrepareAll(W.Tenant)
        assert.ok(AppliedConfigurationEntries.Prepared(W.Map(cluster)).has(running.DescriptorDigest))
        await preparer.PrepareApplied(W.Applied(), W.Target().Target)
        assert.ok(AppliedConfigurationEntries.Prepared(W.Map(cluster)).has(running.DescriptorDigest), 'nor after an apply')
    })

    it('a hand-applied object without a hash annotation gets the applied file hash, so its status holds and is listed', async () =>
    {
        const W = PrepareWorld
        const cluster = W.Cluster()
        const map = W.Map(cluster)
        delete map.metadata.annotations['pragmatic-tech.ai/configuration-hash']
        const preparer = W.Preparer(cluster)
        await preparer.PrepareAll(W.Tenant)
        const annotations = W.Map(cluster).metadata.annotations
        assert.equal(annotations['pragmatic-tech.ai/configuration-hash'], W.Applied().ContentHash())
        assert.ok(ConfigurationPreparationStatus.Of(annotations).Holds(W.Applied().ContentHash()))
        assert.equal((await preparer.For(W.Idp, [W.Target()])).length, 1)
    })

    it('versions that do not compare are not prepared, and said so', async () =>
    {
        const W = PrepareWorld
        const d = W.Idp020()
        const cluster = W.Cluster(new AppliedConfiguration(W.Tenant, W.Idp, 3, 'dev', d.ContentDigest(), W.Document as never))
        const lines: string[] = []
        const [result] = await W.Preparer(cluster, new InMemoryConfigurationRepository(), undefined, lines).PrepareAll(W.Tenant)
        assert.equal(result.Result, PreparationResult.Ahead)
        assert.ok(lines.some(l => l.includes('do not compare')))
    })

    it('writes only what the console owns, conditioned on the resourceVersion it read', async () =>
    {
        const W = PrepareWorld
        const cluster = W.Cluster()
        const map = W.Map(cluster)
        map.data['notes.txt'] = 'put here by someone else'
        map.metadata.annotations['example.com/owner'] = 'someone else'
        map.metadata.labels['example.com/team'] = 'x'
        map.metadata.resourceVersion = '41'
        await W.Preparer(cluster).PrepareAll(W.Tenant)
        const body = cluster.Calls.filter(c => c.method === KubeMethod.Patch && c.path.startsWith(W.ConfigMapPath)).map(c => c.body as Obj)[0]
        assert.equal('notes.txt' in body.data, false)
        assert.equal('example.com/owner' in body.metadata.annotations, false)
        assert.equal('example.com/team' in body.metadata.labels, false)
        assert.equal(body.metadata.resourceVersion, '41')
        assert.ok('configuration.json' in body.data)
    })

    it('an entry of another component is not taken for prepared; a refused setting name is unescaped', async () =>
    {
        const W = PrepareWorld
        const cluster = W.Cluster()
        const map = W.Map(cluster)
        const d = W.Idp024()
        const foreign = new AppliedConfiguration(W.Tenant, 'pragmatic-hive-agent', 4, d.Version, d.ContentDigest(), { options: {} })
        const marked = AppliedConfigurationEntries.With(map as never, foreign)
        marked.metadata.annotations = ConfigurationPreparationStatus.Of(marked.metadata.annotations).DerivedFrom(W.Applied().ContentHash()).WithPrepared(d.ContentDigest()).Over(marked.metadata.annotations)
        cluster.Objects.set(W.ConfigMapPath, marked as never)
        await W.Preparer(cluster).PrepareAll(W.Tenant)
        assert.equal(AppliedConfigurationEntries.Prepared(W.Map(cluster)).get(d.ContentDigest())?.Component, W.Idp, 'prepared again for its own component')
        const odd = W.Cluster(W.Applied({ options: { ...W.Document.options, 'a/b': {} } }))
        const [refused] = await W.Preparer(odd).PrepareAll(W.Tenant)
        assert.deepEqual(refused.Settings, ['a/b'])
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
