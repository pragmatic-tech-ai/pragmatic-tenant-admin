import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { AuthorizationOutcome, ClaimsAuthorizer, RequestContext, RouteTable, SessionPolicy, SessionRecord } from '@pragmatic-tech-ai/pragmatic-app-host'
import { AgentInternalLink, ConsoleAddressOption, HiveEnrolmentCall, HiveEnrolmentRefusal, HiveEnrolmentStatus, HiveLevel } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { TenantRoles, TenantSessionClaims } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { EngineConsoleHost } from '../engine-console-host.js'
import { EngineConsoleAddress, EnrolmentRoutes } from '../enrolment-routes.js'
import { HiveEnrolmentClient, HiveEnrolmentClientError, type IHiveEnrolmentAgent } from '../hive-enrolment-client.js'
import { ResRecorder } from '../../tests/res-recorder.js'

/** The hive agent, standing in: records the calls, enrols or refuses as the test sets. */
class FakeAgent implements IHiveEnrolmentAgent
{
    public readonly Calls: HiveEnrolmentCall[] = []
    public Refusal: HiveEnrolmentRefusal | undefined
    public Current = HiveEnrolmentStatus.NotEnrolled

    public async Enrol(call: HiveEnrolmentCall): Promise<HiveEnrolmentStatus>
    {
        this.Calls.push(call)
        if (this.Refusal !== undefined)
        {
            throw new HiveEnrolmentClientError(this.Refusal)
        }
        this.Current = HiveEnrolmentStatus.Of('hvabcdefghij', 'acme', call.Level)
        return this.Current
    }

    public async Status(): Promise<HiveEnrolmentStatus>
    {
        return this.Current
    }
}

class RoutesFixture
{
    public static readonly Tenant = 'acme'
    public static readonly Code = 'pe1-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    public static readonly Host = 'console.acme.example'

    public static Session(roles: readonly string[]): SessionRecord
    {
        const C = TenantSessionClaims
        const now = new Date()
        return new SessionRecord('sid', 'ann', C.Of(RoutesFixture.Tenant, 'ann@acme.test').With(C.RolesClaim, [...roles]), now, new Date(now.getTime() + 60_000), now, new SessionPolicy(60_000))
    }

    public static async Send(routes: EnrolmentRoutes, method: string, path: string, body?: unknown, roles: readonly string[] = [TenantRoles.Admin]): Promise<{ status: number, json: Record<string, unknown> }>
    {
        const table = new RouteTable()
        routes.Register(table)
        const match = table.Match(method, path)
        assert.ok(match.Route !== undefined, method + ' ' + path)
        const session = RoutesFixture.Session(roles)
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

describe('EnrolmentRoutes', () =>
{
    const F = RoutesFixture

    it('only admin may enrol; any session reads the status', async () =>
    {
        const agent = new FakeAgent()
        const routes = new EnrolmentRoutes(agent, new EngineConsoleAddress(ConsoleAddressOption.OwnDomain, F.Host))
        assert.equal((await F.Send(routes, 'POST', EnrolmentRoutes.EnrolPath, { Code: F.Code, Level: HiveLevel.Enrolled }, [TenantRoles.EnvironmentAdmin])).status, 403)
        assert.equal((await F.Send(routes, 'POST', EnrolmentRoutes.EnrolPath, { Code: F.Code, Level: HiveLevel.Enrolled }, [])).status, 403)
        assert.equal(agent.Calls.length, 0)
        const status = await F.Send(routes, 'GET', EnrolmentRoutes.EnrolmentPath, undefined, [])
        assert.equal(status.status, 200)
        assert.equal(status.json.Enrolled, false)
        assert.deepEqual(status.json.ConsoleAddress, { Option: ConsoleAddressOption.OwnDomain, HostName: F.Host, NeedsIngressAddress: false })
        const enrolled = await F.Send(routes, 'POST', EnrolmentRoutes.EnrolPath, { Code: ' ' + F.Code + ' ', Level: HiveLevel.Delegated })
        assert.equal(enrolled.status, 200)
        assert.equal(enrolled.json.HiveId, 'hvabcdefghij')
        assert.equal(enrolled.json.Level, HiveLevel.Delegated)
        assert.equal(agent.Calls[0]?.Code, F.Code)
        assert.equal(agent.Calls[0]?.ConsoleAddress.HostName, F.Host)
    })

    it('the agent\'s refusals answer their code; a refusal of the console itself is unavailable', async () =>
    {
        const agent = new FakeAgent()
        const routes = new EnrolmentRoutes(agent, new EngineConsoleAddress(ConsoleAddressOption.OwnDomain, F.Host))
        for (const code of [HiveEnrolmentRefusal.Mismatch, HiveEnrolmentRefusal.InvalidCode, HiveEnrolmentRefusal.AlreadyEnrolled, HiveEnrolmentRefusal.TrustRootMismatch, HiveEnrolmentRefusal.Unavailable])
        {
            agent.Refusal = code
            const reply = await F.Send(routes, 'POST', EnrolmentRoutes.EnrolPath, { Code: F.Code, Level: HiveLevel.Enrolled })
            assert.equal(reply.status, AgentInternalLink.StatusOf(code))
            assert.deepEqual(reply.json, AgentInternalLink.RefusalBody(code))
        }
        agent.Refusal = HiveEnrolmentRefusal.NotConsole
        assert.equal((await F.Send(routes, 'POST', EnrolmentRoutes.EnrolPath, { Code: F.Code, Level: HiveLevel.Enrolled })).json.code, HiveEnrolmentRefusal.Unavailable)
    })

    it('a bad code, Standalone, Hosted or a missing ingress address is malformed and never reaches the agent', async () =>
    {
        const agent = new FakeAgent()
        const own = new EnrolmentRoutes(agent, new EngineConsoleAddress(ConsoleAddressOption.OwnDomain, F.Host))
        for (const body of [{ Code: 'has spaces in it', Level: HiveLevel.Enrolled }, { Code: F.Code, Level: HiveLevel.Standalone }, { Code: F.Code, Level: HiveLevel.Hosted }, { Level: HiveLevel.Enrolled }])
        {
            assert.equal((await F.Send(own, 'POST', EnrolmentRoutes.EnrolPath, body)).json.code, HiveEnrolmentRefusal.Malformed)
        }
        const subdomain = new EnrolmentRoutes(agent, new EngineConsoleAddress(ConsoleAddressOption.HiveSubdomain, 'acme.hives.pragmatic-tech.ai'))
        assert.equal((await F.Send(subdomain, 'POST', EnrolmentRoutes.EnrolPath, { Code: F.Code, Level: HiveLevel.Enrolled })).json.code, HiveEnrolmentRefusal.Malformed)
        assert.equal(agent.Calls.length, 0)
        assert.equal((await F.Send(subdomain, 'POST', EnrolmentRoutes.EnrolPath, { Code: F.Code, Level: HiveLevel.Enrolled, IngressAddress: '203.0.113.7' })).status, 200)
        assert.equal(agent.Calls[0]?.ConsoleAddress.IngressAddress, '203.0.113.7')
    })

    it('only a connected engine has enrolment routes', () =>
    {
        assert.equal(EngineConsoleHost.EnrolmentRoutesOf({}), undefined)
        assert.equal(EngineConsoleHost.EnrolmentRoutesOf({ PRAGMATIC_ENGINE_MODE: 'standalone', PRAGMATIC_TENANT_ADMIN_CONSOLE_HOST: F.Host }), undefined)
        const agent = { PRAGMATIC_TENANT_ADMIN_AGENT_URL: 'http://pragmatic-hive-agent-internal.pragmatic-system.svc:7210' }
        assert.ok(EngineConsoleHost.EnrolmentRoutesOf({ PRAGMATIC_ENGINE_MODE: 'connected', PRAGMATIC_TENANT_ADMIN_CONSOLE_HOST: F.Host, ...agent }) instanceof EnrolmentRoutes)
        assert.equal(EngineConsoleHost.EnrolmentRoutesOf({ PRAGMATIC_ENGINE_MODE: 'connected', PRAGMATIC_TENANT_ADMIN_CONSOLE_HOST: F.Host }), undefined, 'a hosted engine names no agent URL')
        assert.throws(() => EngineConsoleHost.EnrolmentRoutesOf({ PRAGMATIC_ENGINE_MODE: 'connected', ...agent }), /PRAGMATIC_TENANT_ADMIN_CONSOLE_HOST/)
        assert.throws(() => EngineConsoleHost.EnrolmentRoutesOf({ PRAGMATIC_ENGINE_MODE: 'connected', PRAGMATIC_TENANT_ADMIN_CONSOLE_HOST: F.Host, PRAGMATIC_TENANT_ADMIN_CONSOLE_ADDRESS: 'elsewhere', ...agent }), /PRAGMATIC_TENANT_ADMIN_CONSOLE_ADDRESS/)
    })
})

describe('HiveEnrolmentClient', () =>
{
    it('calls the agent with the projected token and reads its status and refusal codes', async () =>
    {
        const seen: { method: string, url: string, auth: string | undefined, body: string }[] = []
        let answer: { status: number, body: unknown } = { status: 200, body: HiveEnrolmentStatus.NotEnrolled.ToJson() }
        const server = createServer((req, res) =>
        {
            const chunks: Buffer[] = []
            req.on('data', chunk => chunks.push(chunk as Buffer))
            req.on('end', () =>
            {
                seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') })
                res.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body))
            })
        })
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        const dir = mkdtempSync(join(tmpdir(), 'enrolment-client-'))
        try
        {
            const tokenFile = join(dir, 'token')
            writeFileSync(tokenFile, 'projected-token\n')
            const client = new HiveEnrolmentClient('http://127.0.0.1:' + (server.address() as AddressInfo).port, tokenFile)
            assert.equal((await client.Status()).Enrolled, false)
            assert.deepEqual([seen[0]?.method, seen[0]?.url, seen[0]?.auth], ['GET', AgentInternalLink.EnrolmentPath, 'Bearer projected-token'])
            answer = { status: 422, body: AgentInternalLink.RefusalBody(HiveEnrolmentRefusal.Mismatch) }
            const call = HiveEnrolmentCall.Create(RoutesFixture.Code, HiveLevel.Enrolled, new EngineConsoleAddress(ConsoleAddressOption.OwnDomain, RoutesFixture.Host).For(null))
            await assert.rejects(client.Enrol(call), (error: unknown) => error instanceof HiveEnrolmentClientError && error.Code === HiveEnrolmentRefusal.Mismatch)
            assert.equal(seen[1]?.url, AgentInternalLink.EnrolPath)
            assert.deepEqual(JSON.parse(seen[1]?.body ?? '{}'), call.ToJson())
            answer = { status: 200, body: { pad: 'x'.repeat(64 * 1024) } }
            await assert.rejects(client.Status(), (error: unknown) => error instanceof HiveEnrolmentClientError && error.Code === HiveEnrolmentRefusal.Unavailable)
            answer = { status: 500, body: { message: 'anything' } }
            await assert.rejects(client.Status(), (error: unknown) => error instanceof HiveEnrolmentClientError && error.Code === HiveEnrolmentRefusal.Unavailable)
            await assert.rejects(new HiveEnrolmentClient('http://127.0.0.1:1', tokenFile).Status(), (error: unknown) => error instanceof HiveEnrolmentClientError && error.Code === HiveEnrolmentRefusal.Unavailable)
            await assert.rejects(new HiveEnrolmentClient('http://127.0.0.1:1', join(dir, 'missing')).Status(), (error: unknown) => error instanceof HiveEnrolmentClientError && error.Code === HiveEnrolmentRefusal.Unavailable)
        }
        finally
        {
            server.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
