import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ComponentDescriptorBuilder, SettingType, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import { ApplyTarget, ConfigurationStartError, ConfigurationStartReason, InMemoryConfigurationRepository, type AppliedConfiguration } from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import { CloudSecretManagerSecretStore, type IRealmSecretStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { RealmSecretWriter } from '@pragmatic-tech-ai/pragmatic-configuration'
import { ConfigurationApplyResult, ConfigurationService, ConfigurationTarget, type IComponentDescriptorSource, type IConfigurationApplier } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ComponentSecretWriter } from '../component-secret-writer.js'
import { InterimSecretMigration, InterimSecretMigrationOutcome, type IConsoleSelfTarget } from '../interim-secret-migration.js'
import { RealmCapableComponents } from '../realm-capable-components.js'
import { RealmComponentSecretWriter } from '../realm-component-secret-writer.js'
import { ConsoleStartFallback } from '../console-start-fallback.js'
import { TenantAdminComponent } from '../../tenant-admin-component.js'
import { FixedTargets } from './configuration-fixture.js'
import { FakeCluster } from './fake-cluster.js'

/** Two components that read the realm home (env server 0.1.4, sign-in service 0.2.8), each with a secret setting; and
 *  the env server's older version, which cannot. */
class Descriptors implements IComponentDescriptorSource
{
    public static readonly Server = 'pragmatic-env-server'
    public static readonly Idp = 'pragmatic-tenant-idp'

    public static Of(name: string, version: string): ComponentDescriptor
    {
        return new ComponentDescriptorBuilder(name, version)
            .Option('core', 'Core', o => o.Setting('pollMs', SettingType.Integer, s => s.Default(1000)).Setting('token', SettingType.String, s => s.Secret()))
            .Build()
    }

    public Names(): readonly string[]
    {
        return [TenantAdminComponent.Name, Descriptors.Server, Descriptors.Idp]
    }

    public Current(component: string): ComponentDescriptor
    {
        return component === Descriptors.Server ? Descriptors.Of(component, '0.1.4') : component === Descriptors.Idp ? Descriptors.Of(component, '0.2.8') : Descriptors.Of(component, '0.1.7')
    }

    public async For(component: string, version: string): Promise<ComponentDescriptor>
    {
        return Descriptors.Of(component, version)
    }
}

/** Applies by recording what it was given and the cluster's call count when it returned; `Reverts` fails those targets. */
class RecordingApplier implements IConfigurationApplier
{
    public readonly Applied: { Document: unknown, Namespace: string, Version: number, CompletedAt: number }[] = []
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
        const result = this.Reverts.has(target.Namespace) ? ConfigurationApplyResult.Reverted : ConfigurationApplyResult.Applied
        this.Applied.push({ Document: applied.Document, Namespace: target.Namespace, Version: applied.Version, CompletedAt: this.cluster.Calls.length })
        return result
    }
}

/** The console's own target, as ConsoleSelfApply answers. */
class SelfTarget implements IConsoleSelfTarget
{
    public Proving = false

    public constructor(private readonly target: ApplyTarget)
    {
    }

    public Is(target: ApplyTarget): boolean
    {
        return target.Equals(this.target)
    }
}

class Scene
{
    public static readonly Tenant = 'acme'
    public static readonly Admin = 'subject-admin'
    public static readonly Server = Descriptors.Server
    public static readonly Idp = Descriptors.Idp
    /** The env server joins the realm-capable components with Task 6; the tests take it as capable from 0.1.4. */
    public static readonly Capable = new RealmCapableComponents(new Map([[Descriptors.Server, '0.1.4'], [Descriptors.Idp, '0.2.8'], [TenantAdminComponent.Name, '0.1.7']]))

    public readonly Cluster = new FakeCluster()
    public readonly Home: IRealmSecretStore = Object.assign(new CloudSecretManagerSecretStore(), { Verify: () => Promise.resolve() })
    public readonly Applier = new RecordingApplier(this.Cluster)
    public readonly Targets = new FixedTargets(new Map([
        [Scene.Server, [Scene.Target('dev1', 'pragmatic-env-dev1', Scene.Server, '0.1.4'), Scene.Target('dev2', 'pragmatic-env-dev2', Scene.Server, '0.1.4')]],
        [Scene.Idp, [Scene.Target('engine', 'pragmatic-system', Scene.Idp, '0.2.8')]],
    ]))
    public readonly Service = new ConfigurationService(new InMemoryConfigurationRepository(), new Descriptors(), this.Targets, this.Applier,
        new RealmComponentSecretWriter(new RealmSecretWriter(this.Home), new ComponentSecretWriter(new KubeApiClient(this.Cluster)), this.Targets, Scene.Tenant, Scene.Capable))

    public static Target(name: string, namespace: string, component: string, version: string): ConfigurationTarget
    {
        return new ConfigurationTarget(name, new ApplyTarget('h1', namespace, component), Descriptors.Of(component, version).ContentDigest(), version)
    }

    public static SecretPath(namespace: string, component: string = Scene.Server): string
    {
        return `/api/v1/namespaces/${namespace}/secrets/pragmatic-secrets-${component}`
    }

    public Interim(namespace: string, data: Record<string, string>, component: string = Scene.Server): void
    {
        const encoded = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Buffer.from(value).toString('base64')]))
        this.Cluster.Put(Scene.SecretPath(namespace, component), { apiVersion: 'v1', kind: 'Secret', metadata: { name: `pragmatic-secrets-${component}`, namespace }, data: encoded })
    }

    public Secret(namespace: string, component: string = Scene.Server): Record<string, string> | undefined
    {
        return this.Cluster.Objects.get(Scene.SecretPath(namespace, component))?.data as Record<string, string> | undefined
    }

    /** Saves the component's configuration referring to `secret:file/token` and applies it to every target. */
    public async AppliedWithFileToken(component: string = Scene.Server, targets: readonly string[] = ['dev1', 'dev2']): Promise<number>
    {
        const saved = await this.Service.Save(Scene.Tenant, component, 0, { options: { core: { pollMs: 5000, token: 'secret:file/token' } } }, Scene.Admin, 'interim')
        for (const target of targets) await this.Service.Apply(Scene.Tenant, component, saved.version, target, Scene.Admin)
        this.Applier.Applied.length = 0
        return saved.version
    }

    public Migration(self?: IConsoleSelfTarget): InterimSecretMigration
    {
        return new InterimSecretMigration(this.Service, new KubeApiClient(this.Cluster), this.Home, self, Scene.Capable)
    }

    public DeletedAt(namespace: string, component: string = Scene.Server): number
    {
        return this.Cluster.Calls.findIndex(call => call.method === 'DELETE' && call.path === Scene.SecretPath(namespace, component))
    }

    public async Outcome(component: string = Scene.Server, self?: IConsoleSelfTarget): Promise<InterimSecretMigrationOutcome>
    {
        return (await this.Migration(self).Run(Scene.Tenant)).find(report => report.Component === component)!.Outcome
    }
}

describe('secrets in the realm secrets home', () =>
{
    it('an entered secret lands in the realm home and the configuration holds a reference; an older target keeps the file store', async () =>
    {
        const scene = new Scene()
        const answer = await scene.Service.PutSecret(Scene.Tenant, Scene.Server, 'dev1', 'token', 'entered-value')
        assert.deepEqual(answer, { name: 'token', reference: 'secret:realm/token' })
        assert.equal(await scene.Home.Get('token'), 'entered-value')
        assert.equal(scene.Cluster.Calls.length, 0, 'nothing is written into the cluster')
        // A name the realm home cannot hold, or a target that cannot read the home, stays in the interim file store.
        assert.equal((await scene.Service.PutSecret(Scene.Tenant, Scene.Server, 'dev1', 'Legacy.Token', 'v')).reference, 'secret:file/Legacy.Token')
        scene.Targets.Targets.set(Scene.Server, [Scene.Target('dev1', 'pragmatic-env-dev1', Scene.Server, '0.1.3')])
        assert.equal((await scene.Service.PutSecret(Scene.Tenant, Scene.Server, 'dev1', 'token', 'v')).reference, 'secret:file/token')
        assert.equal(Scene.Capable.Reads(Scene.Server, undefined), false, 'an unknown version is not taken to read it')
        assert.equal(Scene.Capable.Reads('pragmatic-hive-agent', '9.9.9'), false)
        // Until Task 6 renders the home's settings for environment workloads, the console's own table leaves the env server out.
        assert.equal(RealmCapableComponents.Default.Reads(Scene.Server, '0.1.4'), false)
        assert.equal(RealmCapableComponents.Default.Reads(Scene.Idp, '0.2.8'), true)
        assert.equal(RealmCapableComponents.Default.Reads(TenantAdminComponent.Name, '0.1.6'), false)
    })

    it('the interim Kubernetes Secret is migrated, the version re-applied and only then deleted', async () =>
    {
        const scene = new Scene()
        const applied = await scene.AppliedWithFileToken()
        scene.Interim('pragmatic-env-dev1', { token: 'token-value' })
        scene.Interim('pragmatic-env-dev2', { token: 'token-value' })
        assert.equal(await scene.Outcome(), InterimSecretMigrationOutcome.Moved)
        assert.equal(await scene.Home.Get('token'), 'token-value')
        assert.equal(scene.Applier.Applied.length, 2)
        assert.equal(new Set(scene.Applier.Applied.map(apply => apply.Version)).size, 1, 'one rewritten version for both targets')
        for (const apply of scene.Applier.Applied)
        {
            assert.equal((apply.Document as { options: { core: { token: string } } }).options.core.token, 'secret:realm/token')
            assert.ok(scene.DeletedAt(apply.Namespace) >= apply.CompletedAt, `the Secret of ${apply.Namespace} is deleted only after its apply completed`)
        }
        assert.equal(scene.Secret('pragmatic-env-dev1'), undefined)
        assert.ok((await scene.Service.Component(Scene.Tenant, Scene.Server)).versions.length === applied + 1)
        // Idempotent: nothing is left to move, nothing more is saved.
        assert.equal(await scene.Outcome(), InterimSecretMigrationOutcome.Nothing)
        assert.ok((await scene.Service.Component(Scene.Tenant, Scene.Server)).versions.length === applied + 1)
    })

    it('a failed apply keeps the interim Secret; the next start resumes without saving the version again', async () =>
    {
        const scene = new Scene()
        await scene.AppliedWithFileToken()
        scene.Interim('pragmatic-env-dev1', { token: 'token-value' })
        scene.Interim('pragmatic-env-dev2', { token: 'token-value' })
        scene.Applier.Reverts.add('pragmatic-env-dev2')
        assert.equal(await scene.Outcome(), InterimSecretMigrationOutcome.ApplyFailed)
        assert.equal(scene.Secret('pragmatic-env-dev1'), undefined, 'the applied target loses its Secret')
        assert.ok(scene.Secret('pragmatic-env-dev2') !== undefined, 'the failed one keeps it')
        const versions = (await scene.Service.Component(Scene.Tenant, Scene.Server)).versions.length
        scene.Applier.Reverts.clear()
        assert.equal(await scene.Outcome(), InterimSecretMigrationOutcome.Moved)
        assert.equal(scene.Secret('pragmatic-env-dev2'), undefined)
        assert.equal((await scene.Service.Component(Scene.Tenant, Scene.Server)).versions.length, versions, 'the head was the rewritten version already')
    })

    it('a value the tenant admin entered since is the realm\'s: never overwritten, the targets re-pointed to it, reported as differing', async () =>
    {
        const scene = new Scene()
        await scene.AppliedWithFileToken()
        scene.Interim('pragmatic-env-dev1', { token: 'stale' })
        scene.Interim('pragmatic-env-dev2', { token: 'older' })
        await scene.Home.Put('token', 'entered-since')
        const [report] = (await scene.Migration().Run(Scene.Tenant)).filter(entry => entry.Component === Scene.Server)
        assert.equal(report!.Outcome, InterimSecretMigrationOutcome.Moved)
        assert.deepEqual(report!.Differing, ['token'])
        assert.equal(await scene.Home.Get('token'), 'entered-since')
        assert.equal(scene.Applier.Applied.length, 2)
        assert.equal(scene.Secret('pragmatic-env-dev1'), undefined)
    })

    it('one key with different values across targets or components moves nothing of either component', async () =>
    {
        const scene = new Scene()
        await scene.AppliedWithFileToken()
        await scene.AppliedWithFileToken(Scene.Idp, ['engine'])
        scene.Interim('pragmatic-env-dev1', { token: 'server-value' })
        scene.Interim('pragmatic-system', { token: 'idp-value' }, Scene.Idp)
        const reports = (await scene.Migration().Run(Scene.Tenant)).filter(report => report.Component !== TenantAdminComponent.Name)
        assert.deepEqual(reports.map(report => report.Outcome), [InterimSecretMigrationOutcome.Conflict, InterimSecretMigrationOutcome.Conflict])
        assert.equal(await scene.Home.Get('token'), null)
        assert.equal(scene.Cluster.Objects.size, 2)
        const twoTargets = new Scene()
        await twoTargets.AppliedWithFileToken()
        twoTargets.Interim('pragmatic-env-dev1', { token: 'one' })
        twoTargets.Interim('pragmatic-env-dev2', { token: 'two' })
        assert.equal(await twoTargets.Outcome(), InterimSecretMigrationOutcome.Conflict)
    })

    it('keys that are no realm secret names stay; the others move', async () =>
    {
        const scene = new Scene()
        await scene.AppliedWithFileToken(Scene.Server, ['dev1'])
        scene.Interim('pragmatic-env-dev1', { 'token': 'v', 'Legacy.Key': 'x' })
        const [report] = (await scene.Migration().Run(Scene.Tenant)).filter(entry => entry.Component === Scene.Server)
        assert.equal(report!.Outcome, InterimSecretMigrationOutcome.BadName)
        assert.deepEqual(report!.Keys, ['Legacy.Key'])
        assert.deepEqual(Object.keys(scene.Secret('pragmatic-env-dev1')!), ['Legacy.Key'], 'only the moved key left the Secret')
        assert.equal(await scene.Home.Get('token'), 'v')
    })

    it('a target that cannot read the realm home yet is not re-pointed and keeps its Secret', async () =>
    {
        const scene = new Scene()
        await scene.AppliedWithFileToken()
        scene.Targets.Targets.set(Scene.Server, [Scene.Target('dev1', 'pragmatic-env-dev1', Scene.Server, '0.1.4'), Scene.Target('dev2', 'pragmatic-env-dev2', Scene.Server, '0.1.3')])
        scene.Interim('pragmatic-env-dev1', { token: 'v' })
        scene.Interim('pragmatic-env-dev2', { token: 'v' })
        assert.equal(await scene.Outcome(), InterimSecretMigrationOutcome.AwaitingUpgrade)
        assert.deepEqual(scene.Applier.Applied.map(apply => apply.Namespace), ['pragmatic-env-dev1'])
        assert.ok(scene.Secret('pragmatic-env-dev2') !== undefined)
    })

    it('a target that runs a newer component version gets the rewritten version for that version', async () =>
    {
        const scene = new Scene()
        await scene.AppliedWithFileToken(Scene.Server, ['dev1'])
        scene.Targets.Targets.set(Scene.Server, [Scene.Target('dev1', 'pragmatic-env-dev1', Scene.Server, '0.1.5')])
        scene.Interim('pragmatic-env-dev1', { token: 'v' })
        assert.equal(await scene.Outcome(), InterimSecretMigrationOutcome.Moved)
        const head = (await scene.Service.Component(Scene.Tenant, Scene.Server)).versions.at(-1)!
        assert.equal(head.componentVersion, '0.1.5')
    })

    it('an apply the service refuses (another descriptor runs) fails that target only, and the others still move', async () =>
    {
        const scene = new Scene()
        await scene.AppliedWithFileToken()
        await scene.AppliedWithFileToken(Scene.Idp, ['engine'])
        scene.Interim('pragmatic-env-dev1', { token: 'v' })
        scene.Interim('pragmatic-system', { other: 'w' }, Scene.Idp)
        // dev1 now runs a descriptor no version is saved for: Apply throws.
        scene.Targets.Targets.set(Scene.Server, [new ConfigurationTarget('dev1', new ApplyTarget('h1', 'pragmatic-env-dev1', Scene.Server), 'sha256:' + 'f'.repeat(64), '0.1.4')])
        const reports = await scene.Migration().Run(Scene.Tenant)
        assert.equal(reports.find(report => report.Component === Scene.Server)!.Outcome, InterimSecretMigrationOutcome.ApplyFailed)
        assert.ok(scene.Secret('pragmatic-env-dev1') !== undefined)
        assert.equal(reports.find(report => report.Component === Scene.Idp)!.Outcome, InterimSecretMigrationOutcome.Moved)
    })

    it('the console\'s own target goes last and waits while its own apply is being proven', async () =>
    {
        const scene = new Scene()
        await scene.AppliedWithFileToken(Scene.Idp, ['engine'])
        scene.Interim('pragmatic-system', { other: 'w' }, Scene.Idp)
        const self = new SelfTarget(new ApplyTarget('h1', 'pragmatic-system', Scene.Idp))
        self.Proving = true
        assert.equal(await scene.Outcome(Scene.Idp, self), InterimSecretMigrationOutcome.AwaitingSelfApply)
        assert.equal(scene.Applier.Applied.length, 0)
        self.Proving = false
        assert.equal(await scene.Outcome(Scene.Idp, self), InterimSecretMigrationOutcome.Moved)
    })

    it('the console\'s own component goes last', async () =>
    {
        const scene = new Scene()
        const reports = await scene.Migration().Run(Scene.Tenant)
        assert.equal(reports.at(-1)!.Component, TenantAdminComponent.Name)
        assert.equal(reports[0]!.Component, Scene.Server)
    })

    it('a draft keeps its edits through a failed and a resumed run, and no duplicate version is saved', async () =>
    {
        const scene = new Scene()
        const applied = await scene.AppliedWithFileToken()
        await scene.Service.Save(Scene.Tenant, Scene.Server, applied, { options: { core: { pollMs: 9000, token: 'secret:file/token' } } }, Scene.Admin, 'draft')
        scene.Interim('pragmatic-env-dev1', { token: 'v' })
        scene.Interim('pragmatic-env-dev2', { token: 'v' })
        scene.Applier.Reverts.add('pragmatic-env-dev2')
        await scene.Migration().Run(Scene.Tenant)
        const afterFirst = (await scene.Service.Component(Scene.Tenant, Scene.Server)).versions.length
        scene.Applier.Reverts.clear()
        assert.equal(await scene.Outcome(), InterimSecretMigrationOutcome.Moved)
        const versions = (await scene.Service.Component(Scene.Tenant, Scene.Server)).versions
        assert.equal(versions.length, afterFirst, 'the resumed run reused the rewritten version')
        const head = await scene.Service.Version(Scene.Tenant, Scene.Server, versions.at(-1)!.version)
        assert.deepEqual(head.document, { options: { core: { pollMs: 9000, token: 'secret:realm/token' } } })
    })

    it('a key a pinned file reference still reads stays in the Secret', async () =>
    {
        const scene = new Scene()
        const saved = await scene.Service.Save(Scene.Tenant, Scene.Server, 0, { options: { core: { token: 'secret:file/token@2' } } }, Scene.Admin, 'pinned')
        await scene.Service.Apply(Scene.Tenant, Scene.Server, saved.version, 'dev1', Scene.Admin)
        scene.Interim('pragmatic-env-dev1', { token: 'v' })
        await scene.Migration().Run(Scene.Tenant)
        assert.deepEqual(Object.keys(scene.Secret('pragmatic-env-dev1')!), ['token'])
    })

    it('a bad-name key with different values does not block the component; a Secret that does not read blocks only its own', async () =>
    {
        const scene = new Scene()
        await scene.AppliedWithFileToken()
        await scene.AppliedWithFileToken(Scene.Idp, ['engine'])
        scene.Interim('pragmatic-env-dev1', { 'Legacy.Key': 'a', 'token': 'v' })
        scene.Interim('pragmatic-env-dev2', { 'Legacy.Key': 'b', 'token': 'v' })
        scene.Interim('pragmatic-system', { other: 'w' }, Scene.Idp)
        scene.Cluster.Refusals.set(`GET ${Scene.SecretPath('pragmatic-system', Scene.Idp)}`, 403)
        const reports = await scene.Migration().Run(Scene.Tenant)
        assert.equal(reports.find(report => report.Component === Scene.Server)!.Outcome, InterimSecretMigrationOutcome.BadName)
        assert.equal(reports.find(report => report.Component === Scene.Idp)!.Outcome, InterimSecretMigrationOutcome.ApplyFailed)
        assert.equal(await scene.Home.Get('other'), null)
    })

    it('a draft head keeps its edits, its references rewritten', async () =>
    {
        const scene = new Scene()
        const applied = await scene.AppliedWithFileToken(Scene.Server, ['dev1'])
        await scene.Service.Save(Scene.Tenant, Scene.Server, applied, { options: { core: { pollMs: 9000, token: 'secret:file/token' } } }, Scene.Admin, 'draft')
        scene.Interim('pragmatic-env-dev1', { token: 'v' })
        await scene.Migration().Run(Scene.Tenant)
        const versions = (await scene.Service.Component(Scene.Tenant, Scene.Server)).versions
        const head = await scene.Service.Version(Scene.Tenant, Scene.Server, versions.at(-1)!.version)
        assert.deepEqual(head.document, { options: { core: { pollMs: 9000, token: 'secret:realm/token' } } })
    })

    it('rewrites only unpinned file references to the moved keys, and sees every file reference that is left', () =>
    {
        const document = { a: 'secret:file/k', b: ['secret:file/other', 'secret:file/k@2'], c: { d: 'secret:realm/k', e: 3 } }
        const rewritten = InterimSecretMigration.Rewritten(document, ['k'])
        assert.deepEqual(rewritten, { a: 'secret:realm/k', b: ['secret:file/other', 'secret:file/k@2'], c: { d: 'secret:realm/k', e: 3 } })
        assert.equal(InterimSecretMigration.RefersToFile(rewritten, 'k'), true, 'a pinned file reference still reads the Secret')
        assert.equal(InterimSecretMigration.RefersToFile({ a: 'secret:realm/k' }, 'k'), false)
    })

    it('a start the realm secrets home refused puts nothing back; a configuration that refused does', () =>
    {
        assert.equal(ConsoleStartFallback.PutsBack(new ConfigurationStartError(ConfigurationStartReason.SecretsHomeUnavailable, 'x')), false)
        assert.equal(ConsoleStartFallback.PutsBack(new ConfigurationStartError(ConfigurationStartReason.Invalid, 'x')), true)
        assert.equal(ConsoleStartFallback.PutsBack(new Error('x')), true)
    })
})
