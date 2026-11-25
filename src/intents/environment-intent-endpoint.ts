import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ConsoleIntentCall, ConsoleIntentLink, ConsoleIntentRefusal, ProtocolDecodeError, type ConsoleEnvironmentListing } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { EnvironmentIntentApplier } from './environment-intent-applier.js'

/** Whether a bearer is the hive agent's (AgentCallerCheck). */
export interface IAgentCallers
{
    IsAgent(authorization: string | undefined): Promise<boolean>
}

/**
 * How many caller checks (TokenReviews) one request source may cause per minute: the agent sends a handful, so a
 * source past the budget is answered 503 `unavailable` without a review, and the API server is never flooded.
 */
export class CallerReviewBudget
{
    public static readonly PerMinute = 60
    private static readonly WindowMs = 60_000
    private readonly windows = new Map<string, { Start: number, Count: number }>()

    public constructor(private readonly perMinute: number = CallerReviewBudget.PerMinute, private readonly now: () => number = () => Date.now())
    {
    }

    /** Whether `source` may have one more review now (counted when it may). */
    public Take(source: string): boolean
    {
        const at = this.now()
        const window = this.windows.get(source)
        if (window === undefined || at - window.Start >= CallerReviewBudget.WindowMs)
        {
            this.Sweep(at)
            this.windows.set(source, { Start: at, Count: 1 })
            return true
        }
        if (window.Count >= this.perMinute)
        {
            return false
        }
        window.Count += 1
        return true
    }

    private Sweep(at: number): void
    {
        for (const [source, window] of this.windows)
        {
            if (at - window.Start >= CallerReviewBudget.WindowMs)
            {
                this.windows.delete(source)
            }
        }
    }
}

/** The console's environments as the agent reads them (ConsoleEnvironments). */
export interface IConsoleEnvironmentSource
{
    List(): Promise<ConsoleEnvironmentListing>
}

/** What the endpoint logs: event names and codes only, never a token or a body. */
export interface IEnvironmentIntentLog
{
    Event(event: string, code?: string): void
}

/**
 * The console's internal intent endpoint (C3.4), its own cluster-internal listener on port 7211, apart from the public
 * one: `GET /internal/environments` answers the console's environments (ConsoleEnvironmentListing); `POST
 * /internal/environment-intents` with the hive agent's projected token (AgentCallerCheck; anyone else is 403
 * `not-agent`) and a ConsoleIntentCall answers the ConsoleIntentOutcome the applier reached; a body that is not a call
 * of a forwarded kind is 400 `malformed`. Every other path is 404, every other method 405.
 */
export class EnvironmentIntentEndpoint
{
    private static readonly Post = 'POST'
    private static readonly Get = 'GET'
    private static readonly StatusOk = 200
    private static readonly StatusNotFound = 404
    private static readonly StatusMethodNotAllowed = 405
    private static readonly StatusTooLarge = 413
    private static readonly ContentType = 'Content-Type'
    private static readonly JsonType = 'application/json'
    private static readonly CacheControl = 'Cache-Control'
    private static readonly NoStore = 'no-store'
    private static readonly QuerySeparator = '?'
    private static readonly Utf8 = 'utf8'
    private static readonly NotFoundBody = { error: 'not-found' }
    private static readonly MethodBody = { error: 'method-not-allowed' }
    private static readonly UnknownSource = 'unknown'
    private static readonly AppliedEvent = 'intent-outcome'
    private static readonly CallerRefusedEvent = 'intent-caller-refused'
    private static readonly BudgetEvent = 'intent-caller-over-budget'
    private static readonly TooLargeEvent = 'intent-too-large'
    private static readonly MalformedEvent = 'intent-malformed'
    private static readonly FailedEvent = 'intent-endpoint-failed'
    private static readonly ErrorEvent = 'error'
    private static readonly DataEvent = 'data'
    private static readonly EndEvent = 'end'
    private static readonly AnyAddress = '0.0.0.0'

    private server: Server | undefined

    public constructor(
        private readonly applier: EnvironmentIntentApplier,
        private readonly environments: IConsoleEnvironmentSource,
        private readonly callers: IAgentCallers,
        private readonly log: IEnvironmentIntentLog,
        private readonly budget: CallerReviewBudget = new CallerReviewBudget())
    {
    }

    public Listen(port: number = ConsoleIntentLink.Port, bind: string = EnvironmentIntentEndpoint.AnyAddress): Promise<void>
    {
        const server = createServer((req, res) =>
        {
            void this.Serve(req, res)
        })
        // Node ends a request that is not answered within requestTimeout (5 minutes by default); creating an environment can
        // take longer, so the server allows as long as the agent waits for an answer (ConsoleIntentLink.TimeoutMs).
        server.requestTimeout = ConsoleIntentLink.TimeoutMs
        return new Promise((resolve, reject) =>
        {
            server.once(EnvironmentIntentEndpoint.ErrorEvent, reject)
            server.listen(port, bind, () =>
            {
                server.off(EnvironmentIntentEndpoint.ErrorEvent, reject)
                this.server = server
                resolve()
            })
        })
    }

    public Address(): { address: string, port: number }
    {
        const address = this.server?.address() as AddressInfo
        return { address: address.address, port: address.port }
    }

    public async Close(): Promise<void>
    {
        const server = this.server
        this.server = undefined
        if (server !== undefined)
        {
            server.closeAllConnections()
            await new Promise<void>(resolve => server.close(() => resolve()))
        }
    }

    private async Serve(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const E = EnvironmentIntentEndpoint
        try
        {
            const path = (req.url ?? '').split(E.QuerySeparator)[0]
            const method = path === ConsoleIntentLink.Path ? E.Post : path === ConsoleIntentLink.EnvironmentsPath ? E.Get : undefined
            if (method === undefined)
            {
                req.resume()
                E.Write(res, E.StatusNotFound, E.NotFoundBody)
                return
            }
            if (req.method !== method)
            {
                req.resume()
                E.Write(res, E.StatusMethodNotAllowed, E.MethodBody)
                return
            }
            if (!this.budget.Take(req.socket.remoteAddress ?? E.UnknownSource))
            {
                req.resume()
                this.log.Event(E.BudgetEvent)
                E.Refuse(res, ConsoleIntentRefusal.Unavailable)
                return
            }
            if (!await this.callers.IsAgent(req.headers.authorization))
            {
                req.resume()
                this.log.Event(E.CallerRefusedEvent)
                E.Refuse(res, ConsoleIntentRefusal.NotAgent)
                return
            }
            if (method === E.Get)
            {
                req.resume()
                E.Write(res, E.StatusOk, (await this.environments.List()).ToJson())
                return
            }
            const text = await E.ReadBody(req)
            if (text === undefined)
            {
                this.log.Event(E.TooLargeEvent)
                E.Write(res, E.StatusTooLarge, ConsoleIntentLink.RefusalBody(ConsoleIntentRefusal.Malformed))
                return
            }
            let call: ConsoleIntentCall
            try
            {
                call = ConsoleIntentCall.Parse(JSON.parse(text) as unknown)
            }
            catch (error)
            {
                if (error instanceof ProtocolDecodeError || error instanceof SyntaxError)
                {
                    this.log.Event(E.MalformedEvent)
                    E.Refuse(res, ConsoleIntentRefusal.Malformed)
                    return
                }
                throw error
            }
            const outcome = await this.applier.Apply(call)
            this.log.Event(E.AppliedEvent, outcome.Failure ?? outcome.Progress)
            E.Write(res, E.StatusOk, outcome.ToJson())
        }
        catch (error)
        {
            this.log.Event(E.FailedEvent, error instanceof Error ? error.name : undefined)
            if (!res.headersSent)
            {
                E.Refuse(res, ConsoleIntentRefusal.Unavailable)
            }
        }
    }

    private static Refuse(res: ServerResponse, code: ConsoleIntentRefusal): void
    {
        EnvironmentIntentEndpoint.Write(res, ConsoleIntentLink.StatusOf(code), ConsoleIntentLink.RefusalBody(code))
    }

    private static Write(res: ServerResponse, status: number, body: unknown): void
    {
        const E = EnvironmentIntentEndpoint
        res.writeHead(status, { [E.ContentType]: E.JsonType, [E.CacheControl]: E.NoStore })
        res.end(JSON.stringify(body))
    }

    /** The body under the endpoint's limit, or undefined when it is over (the rest is drained). */
    private static ReadBody(req: IncomingMessage): Promise<string | undefined>
    {
        const E = EnvironmentIntentEndpoint
        return new Promise((resolve, reject) =>
        {
            const chunks: Buffer[] = []
            let size = 0
            let tooLarge = false
            req.on(E.DataEvent, (chunk: Buffer) =>
            {
                size += chunk.length
                if (size > ConsoleIntentLink.BodyLimit)
                {
                    tooLarge = true
                    chunks.length = 0
                    return
                }
                if (!tooLarge)
                {
                    chunks.push(chunk)
                }
            })
            req.on(E.EndEvent, () => resolve(tooLarge ? undefined : Buffer.concat(chunks).toString(E.Utf8)))
            req.on(E.ErrorEvent, reject)
        })
    }
}
