import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { AuthorizationOutcome, ClaimsAuthorizer, RequestContext, RouteTable, SessionPolicy, SessionRecord } from '@pragmatic-tech-ai/pragmatic-app-host'
import {
    CreateEnvironment, EnvironmentPurpose, HiveLevel, IntentChoice, IntentDecisionRefusal, IntentInternalLink, IntentProgress, IntentStatus, KeptIntentListing,
    KeptIntentView, IntentDecisionCall,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { TenantRoles, TenantSessionClaims } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { HiveIntentsClient, HiveIntentsClientError, type IHiveIntentsAgent } from '../hive-intents-client.js'
import { PlatformIntentRoutes } from '../platform-intent-routes.js'
import { ResRecorder } from '../../tests/res-recorder.js'

class IntentSamples
{
    public static readonly Id = 'inabcdefghijkl'
    public static readonly Digest = 'sha256:' + 'd'.repeat(64)

    public static View(progress: IntentProgress = IntentProgress.AwaitingApproval): KeptIntentView
    {
        return KeptIntentView.Create({
            IntentId: IntentSamples.Id, IntentDigest: IntentSamples.Digest, Level: HiveLevel.Enrolled, Action: new CreateEnvironment('prod', EnvironmentPurpose.Runtime, null),
            IssuedAt: new Date('2026-11-24T00:00:00.000Z'), ExpiresAt: new Date('2026-12-01T00:00:00.000Z'), Status: IntentStatus.Of(IntentSamples.Id, progress),
        })
    }
}

/** The hive agent's intent routes, standing in: records the decisions, answers or refuses as the test sets. */
class FakeIntentsAgent implements IHiveIntentsAgent
{
    public readonly Decisions: { Id: string, Call: IntentDecisionCall }[] = []
    public Refusal: IntentDecisionRefusal | undefined

    public async List(): Promise<KeptIntentListing>
    {
        return KeptIntentListing.Of([IntentSamples.View()])
    }

    public async Decide(intentId: string, call: IntentDecisionCall): Promise<KeptIntentView>
    {
        this.Decisions.push({ Id: intentId, Call: call })
        if (this.Refusal !== undefined)
        {
            throw new HiveIntentsClientError(this.Refusal)
        }
        return IntentSamples.View(call.Decision === IntentChoice.Approve ? IntentProgress.Applying : IntentProgress.Rejected)
    }
}

class IntentRoutesFixture
{
    public static readonly Tenant = 'acme'
    public static readonly Principal = 'p-0001'
    public static readonly Email = 'ann@acme.test'

    public static async Send(routes: PlatformIntentRoutes, method: string, path: string, body?: unknown, roles: readonly string[] = [TenantRoles.Admin]): Promise<{ status: number, json: Record<string, unknown> }>
    {
        const F = IntentRoutesFixture
        const table = new RouteTable()
        routes.Register(table)
        const match = table.Match(method, path)
        assert.ok(match.Route !== undefined, method + ' ' + path)
        const C = TenantSessionClaims
        const now = new Date()
        const session = new SessionRecord('sid', F.Principal, C.Of(F.Tenant, F.Email).With(C.RolesClaim, [...roles]), now, new Date(now.getTime() + 60_000), now, new SessionPolicy(60_000))
        if (new ClaimsAuthorizer().Authorize(match.Route.Definition, session) !== AuthorizationOutcome.Allowed)
        {
            return { status: 403, json: {} }
        }
        const text = body === undefined ? '' : JSON.stringify(body)
        const req = Object.assign(Readable.from(text === '' ? [] : [Buffer.from(text)]), { method, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) } })
        const res = new ResRecorder()
        const ctx = new RequestContext(req as unknown as IncomingMessage, res as unknown as ServerResponse, path, match.Params, new URLSearchParams(), session, '127.0.0.1', 4096)
        await match.Route.Definition.Handler(ctx)
        return { status: res.status, json: res.body === '' ? {} : JSON.parse(res.body) as Record<string, unknown> }
    }
}

describe('PlatformIntentRoutes', () =>
{
    const F = IntentRoutesFixture
    const approve = '/tenant-api/intents/' + IntentSamples.Id + '/approve'
    const reject = '/tenant-api/intents/' + IntentSamples.Id + '/reject'

    it('only admin may approve or reject; any session lists', async () =>
    {
        const agent = new FakeIntentsAgent()
        const routes = new PlatformIntentRoutes(agent)
        assert.equal((await F.Send(routes, 'POST', approve, { IntentDigest: IntentSamples.Digest }, [TenantRoles.EnvironmentAdmin])).status, 403)
        assert.equal((await F.Send(routes, 'POST', reject, { IntentDigest: IntentSamples.Digest }, [])).status, 403)
        assert.equal(agent.Decisions.length, 0)
        const listed = await F.Send(routes, 'GET', PlatformIntentRoutes.IntentsPath, undefined, [])
        assert.equal(listed.status, 200)
        assert.equal((listed.json.Intents as Record<string, unknown>[])[0]?.IntentId, IntentSamples.Id)
        const approved = await F.Send(routes, 'POST', approve, { IntentDigest: IntentSamples.Digest })
        assert.equal(approved.status, 200)
        assert.equal(approved.json.Progress, IntentProgress.Applying)
        const rejected = await F.Send(routes, 'POST', reject, { IntentDigest: IntentSamples.Digest })
        assert.equal(rejected.json.Progress, IntentProgress.Rejected)
        assert.deepEqual(agent.Decisions.map(entry => entry.Call.Decision), [IntentChoice.Approve, IntentChoice.Reject])
    })

    it('the approver sent to the agent is the session\'s realm subject, never an email', async () =>
    {
        const agent = new FakeIntentsAgent()
        await F.Send(new PlatformIntentRoutes(agent), 'POST', approve, { IntentDigest: IntentSamples.Digest })
        const call = agent.Decisions[0]?.Call
        assert.ok(call !== undefined)
        assert.deepEqual(call.Approver.ToJson(), { Realm: F.Tenant, Subject: F.Principal })
        assert.equal(call.IntentDigest, IntentSamples.Digest)
        assert.ok(!JSON.stringify(call.ToJson()).includes(F.Email))
    })

    it('a missing or broken digest is malformed and never reaches the agent; the agent\'s refusals answer their codes', async () =>
    {
        const agent = new FakeIntentsAgent()
        const routes = new PlatformIntentRoutes(agent)
        for (const body of [{}, { IntentDigest: 'latest' }])
        {
            const reply = await F.Send(routes, 'POST', approve, body)
            assert.deepEqual(reply.json, IntentInternalLink.RefusalBody(IntentDecisionRefusal.Malformed))
        }
        assert.equal(agent.Decisions.length, 0)
        for (const code of [IntentDecisionRefusal.Expired, IntentDecisionRefusal.DigestMismatch, IntentDecisionRefusal.NotAwaiting, IntentDecisionRefusal.UnknownIntent])
        {
            agent.Refusal = code
            const reply = await F.Send(routes, 'POST', approve, { IntentDigest: IntentSamples.Digest })
            assert.equal(reply.status, IntentInternalLink.StatusOf(code))
            assert.deepEqual(reply.json, IntentInternalLink.RefusalBody(code))
        }
        agent.Refusal = IntentDecisionRefusal.NotConsole
        assert.equal((await F.Send(routes, 'POST', approve, { IntentDigest: IntentSamples.Digest })).json.code, IntentDecisionRefusal.Unavailable)
    })
})

describe('PlatformIntentRoutes while the agent is busy', () =>
{
    it('a decision the agent could not answer in time shows the intent as the agent keeps it now, not a failure', async () =>
    {
        const agent = new FakeIntentsAgent()
        agent.Refusal = IntentDecisionRefusal.Unavailable
        const routes = new PlatformIntentRoutes(agent)
        const reply = await IntentRoutesFixture.Send(routes, 'POST', '/tenant-api/intents/' + IntentSamples.Id + '/approve', { IntentDigest: IntentSamples.Digest })
        assert.equal(reply.status, 200)
        assert.equal(reply.json.IntentId, IntentSamples.Id)
        assert.equal(reply.json.Progress, IntentProgress.AwaitingApproval)
        const unknown = await IntentRoutesFixture.Send(routes, 'POST', '/tenant-api/intents/inzzzzzzzzzzzz/approve', { IntentDigest: IntentSamples.Digest })
        assert.deepEqual(unknown.json, IntentInternalLink.RefusalBody(IntentDecisionRefusal.Unavailable), 'an intent the agent does not list stays unavailable')
    })
})

describe('HiveIntentsClient', () =>
{
    it('lists and decides with the console\'s token; a refusal is its code, an answer not ours is unavailable', async () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'intents-client-'))
        const tokenFile = join(dir, 'token')
        writeFileSync(tokenFile, 'console-token\n')
        const seen: { method: string, url: string, auth: string | undefined, body: string }[] = []
        let answer: { status: number, body: string } = { status: 200, body: JSON.stringify(KeptIntentListing.Of([IntentSamples.View()]).ToJson()) }
        const server = createServer((req, res) =>
        {
            const chunks: Buffer[] = []
            req.on('data', chunk => chunks.push(chunk as Buffer))
            req.on('end', () =>
            {
                seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') })
                res.writeHead(answer.status, { 'content-type': 'application/json' })
                res.end(answer.body)
            })
        })
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        try
        {
            const client = new HiveIntentsClient('http://127.0.0.1:' + (server.address() as AddressInfo).port, tokenFile)
            assert.equal((await client.List()).Intents[0]?.IntentId, IntentSamples.Id)
            assert.equal(seen[0]?.url, IntentInternalLink.IntentsPath)
            assert.equal(seen[0]?.auth, 'Bearer console-token')
            answer = { status: 410, body: JSON.stringify(IntentInternalLink.RefusalBody(IntentDecisionRefusal.Expired)) }
            const call = IntentDecisionCall.Create(IntentSamples.Digest, IntentChoice.Approve, PlatformIntentRoutes.ApproverOf({ id: 's', tenantId: 'acme', principalId: 'p-1', expiresAt: '' }))
            await assert.rejects(client.Decide(IntentSamples.Id, call), (error: unknown) => error instanceof HiveIntentsClientError && error.Code === IntentDecisionRefusal.Expired)
            assert.equal(seen[1]?.url, IntentInternalLink.DecisionPath(IntentSamples.Id))
            assert.deepEqual(JSON.parse(seen[1]?.body ?? '{}'), call.ToJson())
            answer = { status: 200, body: '{"Intents":"not a list"}' }
            await assert.rejects(client.List(), (error: unknown) => error instanceof HiveIntentsClientError && error.Code === IntentDecisionRefusal.Unavailable)
            const unreadable = new HiveIntentsClient('http://127.0.0.1:' + (server.address() as AddressInfo).port, join(dir, 'missing'))
            await assert.rejects(unreadable.List(), (error: unknown) => error instanceof HiveIntentsClientError && error.Code === IntentDecisionRefusal.Unavailable)
        }
        finally
        {
            server.closeAllConnections()
            await new Promise<void>(resolve => server.close(() => resolve()))
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
