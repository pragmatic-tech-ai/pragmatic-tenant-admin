import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KubeContentType, KubeMethod, type IKubeTransport, type KubeResponse } from '@pragmatic-tech-ai/pragmatic-kube'
import {
    ComponentAtVersion, ConsoleIntentCall, ConsoleIntentLink, ConsoleIntentOutcome, ConsoleIntentRefusal, CreateEnvironment, DeleteEnvironment, EnvironmentPurpose,
    IntentFailure, IntentProgress, Repair, RepairScope, Rotate, RotationSubject, UpdateEnvironment,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import {
    EnvironmentExistsError, EnvStatus, EnvType, Template, type EnvironmentRecord, type IEnvironmentService, type IRecordMap,
} from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { AgentCallerCheck } from '../agent-caller-check.js'
import { EnvironmentIntentApplier, type IConsoleCertificateRenewal } from '../environment-intent-applier.js'
import { EnvironmentIntentEndpoint, type IAgentCallers } from '../environment-intent-endpoint.js'

/** The console's environment service, standing in: records the calls. */
class FakeEnvironments implements Pick<IEnvironmentService, 'Create' | 'Delete' | 'Restart' | 'List'>
{
    public readonly Records: EnvironmentRecord[] = []
    public readonly Calls: unknown[][] = []
    public Fail: Error | undefined

    public async Create(name: string, template: Template, type: EnvType, hostPort?: number, hiveId?: string, creatorPrincipalId?: string): Promise<EnvironmentRecord>
    {
        this.Calls.push(['create', name, template, type, hostPort, hiveId, creatorPrincipalId])
        if (this.Fail !== undefined)
        {
            throw this.Fail
        }
        const record: EnvironmentRecord = { name, type, template, environmentId: name, hiveId, createdAt: '2026-11-24T00:00:00.000Z', status: EnvStatus.Running }
        this.Records.push(record)
        return record
    }

    public async Delete(name: string): Promise<void>
    {
        this.Calls.push(['delete', name])
        this.Records.splice(this.Records.findIndex(record => record.name === name), 1)
    }

    public async Restart(name: string): Promise<EnvironmentRecord>
    {
        this.Calls.push(['restart', name])
        return this.Records.find(record => record.name === name) as EnvironmentRecord
    }

    public List(): readonly EnvironmentRecord[]
    {
        return this.Records
    }
}

class MemoryMap implements IRecordMap<string>
{
    public readonly Location = 'memory'
    public Saved = new Map<string, string>()

    public async Load(): Promise<ReadonlyMap<string, string>>
    {
        return new Map(this.Saved)
    }

    public async Save(all: ReadonlyMap<string, string>): Promise<void>
    {
        this.Saved = new Map(all)
    }
}

class FakeCertificate implements IConsoleCertificateRenewal
{
    public Renewed = 0

    public constructor(private readonly own: boolean)
    {
    }

    public async Renew(): Promise<boolean>
    {
        this.Renewed += this.own ? 1 : 0
        return this.own
    }
}

class AllowList implements IAgentCallers
{
    public async IsAgent(authorization: string | undefined): Promise<boolean>
    {
        return authorization === 'Bearer agent-token-0123456789'
    }
}

/** TokenReview, standing in: authenticates the tokens it was given as their usernames for their audiences. */
class FakeTokenReviews implements IKubeTransport
{
    public readonly Reviews: string[] = []

    public constructor(private readonly users: ReadonlyMap<string, { Username: string, Audiences: string[] }>)
    {
    }

    public async Send(method: KubeMethod, path: string, body: string | undefined, contentType: KubeContentType): Promise<KubeResponse>
    {
        assert.equal(method, KubeMethod.Post)
        assert.equal(contentType, KubeContentType.Json)
        assert.equal(path, '/apis/authentication.k8s.io/v1/tokenreviews')
        const review = JSON.parse(body ?? '{}') as { spec: { token: string, audiences: string[] } }
        this.Reviews.push(review.spec.audiences.join(','))
        const user = this.users.get(review.spec.token)
        const status = user === undefined ? { authenticated: false } : { authenticated: true, user: { username: user.Username }, audiences: user.Audiences }
        return { status: 201, body: JSON.stringify({ status }) }
    }
}

class EndpointWorld
{
    public static readonly Agent = 'system:serviceaccount:pragmatic-system:pragmatic-hive-hvabc-agent'
    public static readonly Version = '0.1.0-early.20'
    public readonly Environments = new FakeEnvironments()
    public readonly Created = new MemoryMap()
    public readonly Certificate: FakeCertificate

    public constructor(ownCertificate: boolean = true)
    {
        this.Certificate = new FakeCertificate(ownCertificate)
    }

    public Applier(certificate: IConsoleCertificateRenewal | undefined = this.Certificate): EnvironmentIntentApplier
    {
        return new EnvironmentIntentApplier({ Service: this.Environments, HiveId: () => 'acme-hive', EngineVersion: EndpointWorld.Version, Created: this.Created, Certificate: certificate })
    }

    public async Endpoint(): Promise<{ Endpoint: EnvironmentIntentEndpoint, Url: string, Events: string[] }>
    {
        const events: string[] = []
        const endpoint = new EnvironmentIntentEndpoint(this.Applier(), new AllowList(), { Event: (event, code) => events.push(event + (code === undefined ? '' : ':' + code)) })
        await endpoint.Listen(0, '127.0.0.1')
        return { Endpoint: endpoint, Url: 'http://127.0.0.1:' + endpoint.Address().port + ConsoleIntentLink.Path, Events: events }
    }

    public static async Post(url: string, body: unknown, token: string = 'agent-token-0123456789'): Promise<{ status: number, json: Record<string, unknown> }>
    {
        const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) })
        return { status: response.status, json: await response.json() as Record<string, unknown> }
    }
}

describe('EnvironmentIntentEndpoint', () =>
{
    it('an environment intent from another service account is 403 and nothing is applied', async () =>
    {
        const world = new EndpointWorld()
        const { Endpoint, Url, Events } = await world.Endpoint()
        try
        {
            const call = ConsoleIntentCall.Create('inabcdefghijkl', new CreateEnvironment('prod', EnvironmentPurpose.Runtime, null)).ToJson()
            const refused = await EndpointWorld.Post(Url, call, 'another-token-0123456789')
            assert.equal(refused.status, 403)
            assert.deepEqual(refused.json, ConsoleIntentLink.RefusalBody(ConsoleIntentRefusal.NotAgent))
            assert.equal(world.Environments.Calls.length, 0)
            assert.ok(Events.every(event => !event.includes('token')))
            const malformed = await EndpointWorld.Post(Url, { IntentId: 'inabcdefghijkl', Action: new Repair(RepairScope.Engine, null).ToJson() })
            assert.equal(malformed.status, 400)
            assert.equal(malformed.json.code, ConsoleIntentRefusal.Malformed)
            assert.equal((await fetch(Url, { method: 'GET' })).status, 405)
            assert.equal((await fetch(Url.replace(ConsoleIntentLink.Path, '/internal/other'), { method: 'POST' })).status, 404)
        }
        finally
        {
            await Endpoint.Close()
        }
    })

    it('create-environment through the endpoint creates the environment as the console\'s own action does', async () =>
    {
        const world = new EndpointWorld()
        const { Endpoint, Url } = await world.Endpoint()
        try
        {
            const reply = await EndpointWorld.Post(Url, ConsoleIntentCall.Create('inabcdefghijkl', new CreateEnvironment('prod', EnvironmentPurpose.Runtime, null)).ToJson())
            assert.equal(reply.status, 200)
            assert.deepEqual(reply.json, ConsoleIntentOutcome.Applied.ToJson())
            // RouteEnvCreate's call: name, template, type, no host port, the console's hive (the creator is the console itself).
            assert.deepEqual(world.Environments.Calls[0], ['create', 'prod', Template.RuntimePostgres, EnvType.Runtime, undefined, 'acme-hive', undefined])
            const dev = await EndpointWorld.Post(Url, ConsoleIntentCall.Create('inbbbbbbbbbbbb', new CreateEnvironment('dev', EnvironmentPurpose.Development, EndpointWorld.Version)).ToJson())
            assert.equal(dev.json.Progress, IntentProgress.Applied)
            assert.deepEqual(world.Environments.Calls[1], ['create', 'dev', Template.DevBlank, EnvType.Development, undefined, 'acme-hive', undefined])
        }
        finally
        {
            await Endpoint.Close()
        }
    })
})

describe('EnvironmentIntentApplier', () =>
{
    it('a retried create is applied once; another environment of that name is environment-exists', async () =>
    {
        const world = new EndpointWorld()
        const create = ConsoleIntentCall.Create('inabcdefghijkl', new CreateEnvironment('prod', EnvironmentPurpose.Runtime, null))
        assert.equal((await world.Applier().Apply(create)).Progress, IntentProgress.Applied)
        // A console restarted between the two: the intent's environment is found by the noted id.
        assert.equal((await world.Applier().Apply(create)).Progress, IntentProgress.Applied)
        assert.equal(world.Environments.Calls.length, 1)
        const other = ConsoleIntentCall.Create('inbbbbbbbbbbbb', new CreateEnvironment('prod', EnvironmentPurpose.Runtime, null))
        assert.deepEqual((await world.Applier().Apply(other)).ToJson(), { Progress: IntentProgress.Failed, Failure: IntentFailure.EnvironmentExists })
        world.Environments.Fail = new EnvironmentExistsError('stage')
        assert.equal((await world.Applier().Apply(ConsoleIntentCall.Create('inhhhhhhhhhhhh', new CreateEnvironment('stage', EnvironmentPurpose.Development, null)))).Failure, IntentFailure.EnvironmentExists)
        world.Environments.Fail = new Error('quota')
        assert.equal((await world.Applier().Apply(ConsoleIntentCall.Create('indddddddddddd', new CreateEnvironment('qa', EnvironmentPurpose.Development, null)))).Failure, IntentFailure.ApplyFailed)
    })

    it('a version other than the engine\'s is version-unavailable; update and repair restart the environment or find none', async () =>
    {
        const world = new EndpointWorld()
        const applier = world.Applier()
        assert.equal((await applier.Apply(ConsoleIntentCall.Create('inabcdefghijkl', new CreateEnvironment('prod', EnvironmentPurpose.Runtime, '9.9.9')))).Failure, IntentFailure.VersionUnavailable)
        assert.equal(world.Environments.Calls.length, 0)
        assert.equal((await applier.Apply(ConsoleIntentCall.Create('inbbbbbbbbbbbb', new UpdateEnvironment('prod', EndpointWorld.Version)))).Failure, IntentFailure.EnvironmentNotFound)
        await applier.Apply(ConsoleIntentCall.Create('incccccccccccc', new CreateEnvironment('prod', EnvironmentPurpose.Runtime, null)))
        assert.equal((await applier.Apply(ConsoleIntentCall.Create('indddddddddddd', new UpdateEnvironment('prod', '9.9.9')))).Failure, IntentFailure.VersionUnavailable)
        assert.equal((await applier.Apply(ConsoleIntentCall.Create('ineeeeeeeeeeee', new UpdateEnvironment('prod', EndpointWorld.Version)))).Progress, IntentProgress.Applied)
        assert.equal((await applier.Apply(ConsoleIntentCall.Create('inffffffffffff', new Repair(RepairScope.Environment, 'prod')))).Progress, IntentProgress.Applied)
        assert.equal((await applier.Apply(ConsoleIntentCall.Create('ingggggggggggg', new Repair(RepairScope.Environment, 'nope')))).Failure, IntentFailure.EnvironmentNotFound)
        assert.deepEqual(world.Environments.Calls.filter(call => call[0] === 'restart'), [['restart', 'prod'], ['restart', 'prod']])
    })

    it('delete is idempotent; a failed environment reports not-ready', async () =>
    {
        const world = new EndpointWorld()
        const applier = world.Applier()
        assert.equal((await applier.Apply(ConsoleIntentCall.Create('inabcdefghijkl', new DeleteEnvironment('prod')))).Progress, IntentProgress.Applied)
        assert.equal(world.Environments.Calls.length, 0)
        await applier.Apply(ConsoleIntentCall.Create('inbbbbbbbbbbbb', new CreateEnvironment('prod', EnvironmentPurpose.Runtime, null)))
        assert.equal((await applier.Apply(ConsoleIntentCall.Create('incccccccccccc', new DeleteEnvironment('prod')))).Progress, IntentProgress.Applied)
        assert.deepEqual(world.Environments.Calls.at(-1), ['delete', 'prod'])
        world.Environments.Records.push({ name: 'broken', type: EnvType.Runtime, template: Template.RuntimePostgres, environmentId: 'broken', createdAt: '', status: EnvStatus.Failed })
        assert.equal((await applier.Apply(ConsoleIntentCall.Create('indddddddddddd', new Repair(RepairScope.Environment, 'broken')))).Failure, IntentFailure.NotReady)
    })

    it('the ingress rotation renews the engine\'s own certificate; an operator\'s certificate, or none, is precheck-refused', async () =>
    {
        const rotate = ConsoleIntentCall.Create('inabcdefghijkl', new Rotate(RotationSubject.IngressCertificate, null))
        const own = new EndpointWorld(true)
        assert.equal((await own.Applier().Apply(rotate)).Progress, IntentProgress.Applied)
        assert.equal(own.Certificate.Renewed, 1)
        const operator = new EndpointWorld(false)
        assert.equal((await operator.Applier().Apply(rotate)).Failure, IntentFailure.PrecheckRefused)
        assert.equal((await operator.Applier(undefined).Apply(rotate)).Failure, IntentFailure.PrecheckRefused)
        assert.equal(ConsoleIntentCall.Forwards(new ComponentAtVersion('pragmatic-tenant-admin', '0.1.13', 'sha256:' + 'a'.repeat(64), 'sha256:' + 'b'.repeat(64), null)), false)
    })
})

describe('AgentCallerCheck', () =>
{
    it('admits only the agent\'s service account for the console\'s audience', async () =>
    {
        const reviews = new FakeTokenReviews(new Map([
            ['agent-token-0123456789', { Username: EndpointWorld.Agent, Audiences: [ConsoleIntentLink.Audience] }],
            ['other-token-0123456789', { Username: 'system:serviceaccount:pragmatic-system:pragmatic-tenant-admin-acme', Audiences: [ConsoleIntentLink.Audience] }],
            ['wrong-audience-0123456', { Username: EndpointWorld.Agent, Audiences: ['https://kubernetes.default.svc'] }],
        ]))
        const check = new AgentCallerCheck(reviews, EndpointWorld.Agent)
        assert.equal(await check.IsAgent('Bearer agent-token-0123456789'), true)
        assert.equal(await check.IsAgent('Bearer other-token-0123456789'), false)
        assert.equal(await check.IsAgent('Bearer wrong-audience-0123456'), false)
        assert.equal(await check.IsAgent('Bearer unknown-token-01234567'), false)
        assert.equal(await check.IsAgent(undefined), false)
        assert.equal(await check.IsAgent('Basic abc'), false)
        assert.ok(reviews.Reviews.every(audience => audience === ConsoleIntentLink.Audience))
    })
})

describe('the intent endpoint is served only by a connected engine that names its agent', () =>
{
    it('a standalone engine, a pushed console, or one without the agent account serves no endpoint and no intent routes', async () =>
    {
        const { TenantAdminServer } = await import('../../tenant-admin-server.js')
        const { EngineComposition } = await import('../../engine-composition.js')
        const { EngineConsoleHost } = await import('../../enrolment/engine-console-host.js')
        const account = { TokenPath: '/t', CaPath: '/c' } as never
        const client = {} as never
        const none = undefined as never
        const connected = { PRAGMATIC_ENGINE_MODE: 'connected', PRAGMATIC_TENANT_ADMIN_AGENT_URL: 'http://agent:7210' }
        for (const env of [{}, { PRAGMATIC_ENGINE_MODE: 'standalone', PRAGMATIC_ENGINE_AGENT_SERVICE_ACCOUNT: EndpointWorld.Agent }, connected])
        {
            assert.equal(await TenantAdminServer.IntentEndpointOf(env, account, client, none, none, none, EngineComposition.From(env), none, () => undefined), undefined)
        }
        const named = { ...connected, PRAGMATIC_ENGINE_AGENT_SERVICE_ACCOUNT: EndpointWorld.Agent }
        assert.equal(await TenantAdminServer.IntentEndpointOf(named, undefined, client, none, none, none, EngineComposition.From(named), none, () => undefined), undefined)
        assert.equal(EngineConsoleHost.IntentRoutesOf({}), undefined)
        assert.equal(EngineConsoleHost.IntentRoutesOf({ PRAGMATIC_ENGINE_MODE: 'standalone' }), undefined)
        assert.ok(EngineConsoleHost.IntentRoutesOf(connected) !== undefined)
    })
})
