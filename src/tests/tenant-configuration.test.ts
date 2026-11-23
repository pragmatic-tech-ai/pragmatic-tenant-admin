import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AuthorizationOutcome, ClaimsAuthorizer, RequestContext, RouteTable, SessionPolicy, SessionRecord } from '@pragmatic-tech-ai/pragmatic-app-host'
import { SecretReference } from '@pragmatic-tech-ai/pragmatic-component'
import { InMemoryConfigurationRepository, type AppliedConfiguration, type ApplyTarget } from '@pragmatic-tech-ai/pragmatic-configuration'
import { PgSession } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import {
    ConfigurationApplyResult, ConfigurationApplyUnavailableError, ConfigurationChangeKind, ConfigurationDescriptorMismatchError, ConfigurationDiff, ConfigurationNoTargetError,
    ConfigurationApplyInProgressError, ConfigurationSecretWriteError, ConfigurationService, TenantConfigurationEndpoint, TenantRoles, TenantSessionClaims, UnavailableComponentSecretWriter, UnavailableConfigurationApplier,
    type IComponentSecretWriter, type IConfigurationApplier,
} from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ReleaseDescriptorCatalogue } from '../configuration/release-descriptor-catalogue.js'
import { ConfigurationFixture as F, FixedTargets } from '../configuration/tests/configuration-fixture.js'
import { TenantAdminComponent } from '../tenant-admin-component.js'
import { TenantAdminDatabase } from '../tenant-admin-database.js'
import { ResRecorder } from './res-recorder.js'

/** Records every apply and answers `Result`; `Fail` makes the next one throw. */
class RecordingApplier implements IConfigurationApplier
{
    public readonly Applied: { applied: AppliedConfiguration; target: ApplyTarget }[] = []
    public Fail = false
    public Result = ConfigurationApplyResult.Applied

    public get Available(): boolean
    {
        return true
    }

    public async Apply(applied: AppliedConfiguration, target: ApplyTarget): Promise<ConfigurationApplyResult>
    {
        if (this.Fail)
        {
            throw new Error('the cluster said no: secret detail')
        }
        this.Applied.push({ applied, target })
        return this.Result
    }
}

class RecordingSecrets implements IComponentSecretWriter
{
    public readonly Written: { component: string; name: string; value: string; namespaces: string[] }[] = []

    public async Put(component: string, name: string, value: string, targets: readonly ApplyTarget[]): Promise<SecretReference>
    {
        this.Written.push({ component, name, value, namespaces: targets.map(t => t.Namespace) })
        return new SecretReference('file', name)
    }
}

class ConfigFixture
{
    public static readonly Document = { options: {} }

    public static Targets(): FixedTargets
    {
        return new FixedTargets(new Map([
            [F.Server, [F.Target('dev1', 'pragmatic-env-dev1', 'pragmatic-env-dev1-server', F.Server010()), F.Target('dev2', 'pragmatic-env-dev2', 'pragmatic-env-dev2-server')]],
            [F.Agent, [F.Target('pragmatic-system', 'pragmatic-system', 'pragmatic-hive-agent-h1', F.Agent020())]],
        ]))
    }

    public static Service(applier: IConfigurationApplier = new RecordingApplier(), secrets: IComponentSecretWriter = new RecordingSecrets(), repository = new InMemoryConfigurationRepository()): ConfigurationService
    {
        const catalogue = new ReleaseDescriptorCatalogue(F.Mounted(), TenantAdminComponent.Descriptor(), F.Registry(), ['0.2.0'])
        return new ConfigurationService(repository, catalogue, ConfigFixture.Targets(), applier, secrets)
    }

    public static Session(roles: readonly string[]): SessionRecord
    {
        const C = TenantSessionClaims
        const claims = C.Of(F.Tenant, 'ann@acme.test').With(C.RolesClaim, [...roles])
        const now = new Date()
        return new SessionRecord('sid', F.Admin, claims, now, new Date(now.getTime() + 60_000), now, new SessionPolicy(60_000))
    }

    /** Runs one request through the configuration routes the way the host does (route, roles, handler). */
    public static async Send(endpoint: TenantConfigurationEndpoint, method: string, path: string, body?: unknown, roles: readonly string[] = [TenantRoles.Admin]): Promise<{ status: number; json: Record<string, unknown>; audit: string[] }>
    {
        const table = new RouteTable()
        endpoint.Register(table)
        const url = new URL(path, 'http://localhost')
        const match = table.Match(method, url.pathname)
        assert.ok(match.Route !== undefined, method + ' ' + path)
        const session = ConfigFixture.Session(roles)
        const res = new ResRecorder()
        if (new ClaimsAuthorizer().Authorize(match.Route.Definition, session) !== AuthorizationOutcome.Allowed)
        {
            return { status: 403, json: {}, audit: [] }
        }
        const text = body === undefined ? '' : JSON.stringify(body)
        const req = Object.assign(Readable.from(text === '' ? [] : [Buffer.from(text)]), { method, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) } })
        const ctx = new RequestContext(req as unknown as IncomingMessage, res as unknown as ServerResponse, url.pathname, match.Params, url.searchParams, session, '127.0.0.1', 65536)
        const audit: string[] = []
        const note = ctx.NoteAudit.bind(ctx)
        ctx.NoteAudit = (detail: string): void => { audit.push(detail); note(detail) }
        await match.Route.Definition.Handler(ctx)
        return { status: res.status, json: res.body === '' ? {} : JSON.parse(res.body) as Record<string, unknown>, audit }
    }
}

describe('ConfigurationDiff', () =>
{
    it('names every added, removed and changed member by its JSON pointer, in path order', () =>
    {
        const changes = ConfigurationDiff.Between(
            { options: { core: { port: 1, bind: 'a' }, gone: { x: 1 }, 'a/b': { '~': 1 } } },
            { options: { core: { port: 2, bind: 'a', extra: true }, 'a/b': { '~': 2 } } })
        assert.deepEqual(changes, [
            { path: '/options/a~1b/~0', kind: ConfigurationChangeKind.Changed, before: 1, after: 2 },
            { path: '/options/core/extra', kind: ConfigurationChangeKind.Added, after: true },
            { path: '/options/core/port', kind: ConfigurationChangeKind.Changed, before: 1, after: 2 },
            { path: '/options/gone', kind: ConfigurationChangeKind.Removed, before: { x: 1 } },
        ])
        assert.deepEqual(ConfigurationDiff.Between({ a: [1, 2] }, { a: [1, 2] }), [])
    })
})

describe('ConfigurationService', () =>
{
    it('lists every component with its head and its labelled targets with what runs there', async () =>
    {
        const list = await ConfigFixture.Service().List(F.Tenant)
        assert.deepEqual(list.map(c => c.component), [F.Server, F.Agent, 'pragmatic-tenant-admin'].sort())
        const server = list.find(c => c.component === F.Server)!
        assert.equal(server.head, null)
        assert.deepEqual(server.targets.map(t => [t.environment, t.namespace, t.deployment, t.componentVersion, t.applied]), [
            ['dev1', 'pragmatic-env-dev1', 'pragmatic-env-dev1-server', '0.1.0', null], ['dev2', 'pragmatic-env-dev2', 'pragmatic-env-dev2-server', null, null],
        ])
    })

    it('saves validated versions in order, for the console\'s release or a named component version; refuses a literal secret and a stale base', async () =>
    {
        const service = ConfigFixture.Service()
        const first = await service.Save(F.Tenant, F.Server, 0, ConfigFixture.Document, F.Admin, 'first')
        assert.deepEqual([first.version, first.componentVersion], [1, '0.1.0'])
        await assert.rejects(service.Save(F.Tenant, F.Server, 0, ConfigFixture.Document, F.Admin, ''), /version 1, not 0/)
        await assert.rejects(service.Save(F.Tenant, F.Server, 1, { options: { nope: {} } }, F.Admin, ''), /rejected/)
        await assert.rejects(service.Save(F.Tenant, F.Agent, 0, { options: { core: { token: 'literal' } } }, F.Admin, ''), /rejected/)
        const agent = await service.Save(F.Tenant, F.Agent, 0, { options: { core: { maxBackoffMs: 1000 } } }, F.Admin, '', '0.2.0')
        assert.deepEqual([agent.componentVersion, agent.descriptorDigest], ['0.2.0', F.Agent020().ContentDigest()])
        await assert.rejects(service.Save(F.Tenant, F.Agent, 1, ConfigFixture.Document, F.Admin, '', '7.0.0'), /ships that component version/)
    })

    it('applies a version to a target: watched, recorded applied; the list shows it', async () =>
    {
        const applier = new RecordingApplier()
        const service = ConfigFixture.Service(applier)
        await service.Save(F.Tenant, F.Server, 0, ConfigFixture.Document, F.Admin, '')
        const record = await service.Apply(F.Tenant, F.Server, 1, 'dev1', F.Admin)
        assert.deepEqual([record.outcome, record.environment], ['applied', 'dev1'])
        assert.equal(applier.Applied[0]?.target.Deployment, 'pragmatic-env-dev1-server')
        const listed = (await service.List(F.Tenant)).find(c => c.component === F.Server)!
        assert.deepEqual([listed.head, ...listed.targets.map(t => t.applied)], [1, 1, null])
        assert.equal(record.detail, '', 'a target whose running descriptor is known is verified')
        assert.equal((await service.Apply(F.Tenant, F.Server, 1, 'dev2', F.Admin)).detail, ConfigurationService.UnverifiedTargetDetail, 'a development image is applied unverified, and says so')
    })

    it('refuses a second apply to a target while the first one waits for its roll', async () =>
    {
        const releases: Array<() => void> = []
        let entered: () => void = () => undefined
        const waiting = new Promise<void>(resolve => { entered = resolve })
        const slow: IConfigurationApplier = {
            Available: true,
            Apply: () => new Promise<ConfigurationApplyResult>(resolve =>
            {
                releases.push(() => resolve(ConfigurationApplyResult.Applied))
                entered()
            }),
        }
        const service = ConfigFixture.Service(slow)
        await service.Save(F.Tenant, F.Server, 0, ConfigFixture.Document, F.Admin, '')
        const first = service.Apply(F.Tenant, F.Server, 1, 'dev1', F.Admin)
        await waiting
        await assert.rejects(service.Apply(F.Tenant, F.Server, 1, 'dev1', F.Admin), ConfigurationApplyInProgressError)
        releases.forEach(release => release())
        assert.equal((await first).outcome, 'applied')
        const again = service.Apply(F.Tenant, F.Server, 1, 'dev1', F.Admin)
        while (releases.length < 2) await new Promise(resolve => setTimeout(resolve, 1))
        releases.forEach(release => release())
        assert.equal((await again).outcome, 'applied', 'free again once the first one ended')
    })

    it('applies a version of a newer component version, its descriptor from that release', async () =>
    {
        const applier = new RecordingApplier()
        const service = ConfigFixture.Service(applier)
        await service.Save(F.Tenant, F.Agent, 0, ConfigFixture.Document, F.Admin, '', '0.2.0')
        assert.equal((await service.Apply(F.Tenant, F.Agent, 1, 'pragmatic-system', F.Admin)).outcome, 'applied')
        assert.equal(applier.Applied[0]?.applied.DescriptorDigest, F.Agent020().ContentDigest())
    })

    it('apply refuses a target whose image runs another descriptor digest, naming both', async () =>
    {
        const applier = new RecordingApplier()
        const service = ConfigFixture.Service(applier)
        await service.Save(F.Tenant, F.Agent, 0, ConfigFixture.Document, F.Admin, '')
        const saved = F.Agent010().ContentDigest()
        const running = F.Agent020().ContentDigest()
        await assert.rejects(service.Apply(F.Tenant, F.Agent, 1, 'pragmatic-system', F.Admin),
            (error: unknown) => error instanceof ConfigurationDescriptorMismatchError && error.message.includes(saved) && error.message.includes(running))
        assert.deepEqual(applier.Applied, [])
        assert.deepEqual((await service.Component(F.Tenant, F.Agent)).applies, [], 'nothing is recorded')
    })

    it('a new pod that never readies: the apply is failed rollout-not-ready; the applied version stays the previous one', async () =>
    {
        const applier = new RecordingApplier()
        const service = ConfigFixture.Service(applier)
        await service.Save(F.Tenant, F.Server, 0, ConfigFixture.Document, F.Admin, '')
        await service.Apply(F.Tenant, F.Server, 1, 'dev1', F.Admin)
        await service.Save(F.Tenant, F.Server, 1, { options: { core: { port: 1 } } }, F.Admin, '')
        applier.Result = ConfigurationApplyResult.Reverted
        const record = await service.Apply(F.Tenant, F.Server, 2, 'dev1', F.Admin)
        assert.deepEqual([record.outcome, record.detail], ['failed', 'rollout-not-ready'])
        assert.equal(ConfigurationService.RolloutNotReadyDetail, 'rollout-not-ready')
        const listed = (await service.List(F.Tenant)).find(c => c.component === F.Server)!
        assert.equal(listed.targets[0].applied, 1)
    })

    it('a failed write is recorded failed with a fixed detail (the cluster\'s text is not kept)', async () =>
    {
        const applier = new RecordingApplier()
        applier.Fail = true
        const service = ConfigFixture.Service(applier)
        await service.Save(F.Tenant, F.Server, 0, ConfigFixture.Document, F.Admin, '')
        const record = await service.Apply(F.Tenant, F.Server, 1, 'dev1', F.Admin)
        assert.deepEqual([record.outcome, record.detail], ['failed', ConfigurationService.WriteFailedDetail])
    })

    it('refuses an unknown component, version or target, a component without a target, and a console outside its cluster', async () =>
    {
        const service = ConfigFixture.Service()
        await service.Save(F.Tenant, F.Server, 0, ConfigFixture.Document, F.Admin, '')
        await assert.rejects(service.Component(F.Tenant, 'pragmatic-platform-admin'), /does not configure/)
        await assert.rejects(service.Apply(F.Tenant, F.Server, 9, 'dev1', F.Admin), /does not exist/)
        await assert.rejects(service.Apply(F.Tenant, F.Server, 1, 'beta-dev', F.Admin), /target does not exist/)
        await service.Save(F.Tenant, 'pragmatic-tenant-admin', 0, ConfigFixture.Document, F.Admin, '')
        await assert.rejects(service.Apply(F.Tenant, 'pragmatic-tenant-admin', 1, 'pragmatic-system', F.Admin), ConfigurationNoTargetError)
        const offline = ConfigFixture.Service(new UnavailableConfigurationApplier(), new UnavailableComponentSecretWriter())
        await offline.Save(F.Tenant, F.Server, 0, ConfigFixture.Document, F.Admin, '')
        await assert.rejects(offline.Apply(F.Tenant, F.Server, 1, 'dev1', F.Admin), ConfigurationApplyUnavailableError)
        await assert.rejects(offline.PutSecret(F.Tenant, F.Server, 'dev1', 'k', 'v'), ConfigurationApplyUnavailableError)
        assert.deepEqual((await offline.Component(F.Tenant, F.Server)).applies, [], 'nothing is recorded')
    })

    it('a secret write answers the reference, writes only the chosen target\'s namespace, refuses a name that is no Secret key', async () =>
    {
        const secrets = new RecordingSecrets()
        const service = ConfigFixture.Service(new RecordingApplier(), secrets)
        assert.deepEqual(await service.PutSecret(F.Tenant, F.Server, 'dev2', 'smtp-password', 'v4lue'), { name: 'smtp-password', reference: 'secret:file/smtp-password' })
        assert.deepEqual(secrets.Written[0].namespaces, ['pragmatic-env-dev2'], 'only that target: an environment never sees another\'s value')
        await assert.rejects(service.PutSecret(F.Tenant, F.Server, 'dev1', '../x', 'v'), /secret name/)
        await assert.rejects(service.PutSecret(F.Tenant, F.Server, 'nowhere', 'k', 'v'), /target does not exist/)
        await assert.rejects(service.PutSecret(F.Tenant, 'pragmatic-tenant-admin', 'pragmatic-system', 'k', 'v'), ConfigurationNoTargetError)
        const refusing = ConfigFixture.Service(new RecordingApplier(), { Put: async () => { throw new Error('the cluster said: v4lue') } })
        await assert.rejects(refusing.PutSecret(F.Tenant, F.Server, 'dev1', 'k', 'v4lue'), (e: Error) => e instanceof ConfigurationSecretWriteError && !e.message.includes('v4lue'))
    })

    it('diffs two versions (from 0 is the empty document) and keeps tenants apart', async () =>
    {
        const service = ConfigFixture.Service()
        await service.Save(F.Tenant, F.Server, 0, ConfigFixture.Document, F.Admin, '')
        const diff = await service.Diff(F.Tenant, F.Server, 0, 1)
        assert.deepEqual(diff.changes, [{ path: '/options', kind: ConfigurationChangeKind.Added, after: {} }])
        assert.deepEqual((await service.Component('beta', F.Server)).versions, [])
    })

    it('runs over the console database (pg-mem)', async () =>
    {
        const database = TenantAdminDatabase.Over(new PgSession(SqlTestSessions.MemPool()))
        const service = ConfigFixture.Service(new RecordingApplier(), new RecordingSecrets(), await database.Configuration() as never)
        await service.Save(F.Tenant, F.Server, 0, ConfigFixture.Document, F.Admin, 'sql')
        assert.equal((await service.Apply(F.Tenant, F.Server, 1, 'dev1', F.Admin)).outcome, 'applied')
        assert.equal((await service.Version(F.Tenant, F.Server, 1)).comment, 'sql')
    })
})

describe('TenantConfigurationEndpoint', () =>
{
    const Base = '/tenant-api/configuration/components/'

    it('reads are open to any session of the tenant; saving, applying and writing secrets need the tenant role admin', async () =>
    {
        const endpoint = new TenantConfigurationEndpoint(ConfigFixture.Service())
        assert.equal((await ConfigFixture.Send(endpoint, 'GET', '/tenant-api/configuration/components', undefined, [])).status, 200)
        assert.equal((await ConfigFixture.Send(endpoint, 'POST', Base + F.Server + '/versions', { basedOn: 0, document: ConfigFixture.Document }, [])).status, 403)
        assert.equal((await ConfigFixture.Send(endpoint, 'POST', Base + F.Server + '/versions/1/apply', { environment: 'dev1' }, [])).status, 403)
        assert.equal((await ConfigFixture.Send(endpoint, 'PUT', Base + F.Server + '/secrets/k', { value: 'v', environment: 'dev1' }, [])).status, 403)
        assert.equal((await ConfigFixture.Send(endpoint, 'PUT', Base + F.Server + '/secrets/k', { value: 'v', environment: 'dev1' }, [TenantRoles.EnvironmentAdmin])).status, 403, 'only the tenant admin role may write secrets')
    })

    it('a secret write answers the reference and the value appears in no response or audit entry', async () =>
    {
        const secrets = new RecordingSecrets()
        const endpoint = new TenantConfigurationEndpoint(ConfigFixture.Service(new RecordingApplier(), secrets))
        const value = 'tr0ub4dor-value-never-echoed'
        const answer = await ConfigFixture.Send(endpoint, 'PUT', Base + F.Server + '/secrets/smtp-password', { value, environment: 'dev1' })
        assert.deepEqual([answer.status, answer.json], [200, { name: 'smtp-password', reference: 'secret:file/smtp-password' }])
        assert.equal(secrets.Written[0].value, value)
        assert.ok(!JSON.stringify(answer).includes(value), 'not in the response or the audit entry')
        assert.deepEqual(answer.audit, [`${F.Server}/smtp-password`])
        assert.equal((await ConfigFixture.Send(endpoint, 'PUT', Base + F.Server + '/secrets/k', { value: '', environment: 'dev1' })).status, 400)
        assert.equal((await ConfigFixture.Send(endpoint, 'PUT', Base + F.Server + '/secrets/k', { value: 'v' })).status, 400, 'the target is required')
        assert.equal((await ConfigFixture.Send(endpoint, 'PUT', Base + F.Server + '/secrets/.hidden', { value: 'v', environment: 'dev1' })).status, 400)
    })

    it('a save answers 201; an invalid document 422 with paths and fixed messages (never the value); a stale base 409 with the head', async () =>
    {
        const endpoint = new TenantConfigurationEndpoint(ConfigFixture.Service())
        const saved = await ConfigFixture.Send(endpoint, 'POST', Base + F.Server + '/versions', { basedOn: 0, document: ConfigFixture.Document, comment: 'c' })
        assert.deepEqual([saved.status, saved.json.version], [201, 1])
        const stale = await ConfigFixture.Send(endpoint, 'POST', Base + F.Server + '/versions', { basedOn: 0, document: ConfigFixture.Document })
        assert.deepEqual([stale.status, stale.json.head], [409, 1])
        const invalid = await ConfigFixture.Send(endpoint, 'POST', Base + F.Server + '/versions', { basedOn: 1, document: { options: { core: { port: 'hunter2-not-a-port' } } } })
        assert.equal(invalid.status, 422)
        assert.equal(JSON.stringify(invalid.json).includes('hunter2'), false)
        assert.equal((await ConfigFixture.Send(endpoint, 'POST', Base + F.Server + '/versions', { basedOn: 'x', document: [] })).status, 400)
        assert.equal((await ConfigFixture.Send(endpoint, 'POST', Base + F.Server + '/versions', { basedOn: 1, document: {}, componentVersion: 3 })).status, 400)
    })

    it('views, diffs, applies; 404 unknown, 409 descriptor-mismatch with both digests, 503 offline or descriptor-unavailable', async () =>
    {
        const endpoint = new TenantConfigurationEndpoint(ConfigFixture.Service())
        await ConfigFixture.Send(endpoint, 'POST', Base + F.Server + '/versions', { basedOn: 0, document: ConfigFixture.Document })
        const version = await ConfigFixture.Send(endpoint, 'GET', Base + F.Server + '/versions/1')
        assert.deepEqual([version.status, version.json.document], [200, ConfigFixture.Document])
        assert.equal((await ConfigFixture.Send(endpoint, 'GET', Base + F.Server + '/diff?from=0&to=1')).status, 200)
        assert.equal((await ConfigFixture.Send(endpoint, 'POST', Base + F.Server + '/versions/1/apply', { environment: 'dev1' })).json.outcome, 'applied')
        assert.equal((await ConfigFixture.Send(endpoint, 'GET', Base + 'pragmatic-platform-admin')).status, 404)
        await ConfigFixture.Send(endpoint, 'POST', Base + F.Agent + '/versions', { basedOn: 0, document: ConfigFixture.Document })
        const mismatch = await ConfigFixture.Send(endpoint, 'POST', Base + F.Agent + '/versions/1/apply', { environment: 'pragmatic-system' })
        assert.deepEqual([mismatch.status, mismatch.json.code, mismatch.json.saved, mismatch.json.running], [409, 'descriptor-mismatch', F.Agent010().ContentDigest(), F.Agent020().ContentDigest()])
        const offline = new TenantConfigurationEndpoint(ConfigFixture.Service(new UnavailableConfigurationApplier()))
        await ConfigFixture.Send(offline, 'POST', Base + F.Server + '/versions', { basedOn: 0, document: ConfigFixture.Document })
        assert.equal((await ConfigFixture.Send(offline, 'POST', Base + F.Server + '/versions/1/apply', { environment: 'dev1' })).status, 503)
    })

    it('a version for a release the registry cannot serve is 503 descriptor-unavailable', async () =>
    {
        const catalogue = new ReleaseDescriptorCatalogue(F.Mounted(), TenantAdminComponent.Descriptor(), undefined, ['0.2.0'])
        const endpoint = new TenantConfigurationEndpoint(new ConfigurationService(new InMemoryConfigurationRepository(), catalogue, ConfigFixture.Targets(), new RecordingApplier(), new RecordingSecrets()))
        const answer = await ConfigFixture.Send(endpoint, 'POST', Base + F.Agent + '/versions', { basedOn: 0, document: ConfigFixture.Document, componentVersion: '0.2.0' })
        assert.deepEqual([answer.status, answer.json.code], [503, 'descriptor-unavailable'])
    })
})
