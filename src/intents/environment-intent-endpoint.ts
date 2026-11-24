import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ConsoleIntentCall, ConsoleIntentLink, ConsoleIntentRefusal, ProtocolDecodeError } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { EnvironmentIntentApplier } from './environment-intent-applier.js'

/** Whether a bearer is the hive agent's (AgentCallerCheck). */
export interface IAgentCallers
{
    IsAgent(authorization: string | undefined): Promise<boolean>
}

/** What the endpoint logs: event names and codes only, never a token or a body. */
export interface IEnvironmentIntentLog
{
    Event(event: string, code?: string): void
}

/**
 * The console's internal intent endpoint (C3.4), its own cluster-internal listener on port 7211, apart from the public
 * one: `POST /internal/environment-intents` with the hive agent's projected token (AgentCallerCheck; anyone else is 403
 * `not-agent`) and a ConsoleIntentCall answers the ConsoleIntentOutcome the applier reached; a body that is not a call
 * of a forwarded kind is 400 `malformed`. Every other path is 404, every other method 405.
 */
export class EnvironmentIntentEndpoint
{
    private static readonly Post = 'POST'
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
    private static readonly TooLargeBody = { error: 'too-large' }
    private static readonly AppliedEvent = 'intent-outcome'
    private static readonly CallerRefusedEvent = 'intent-caller-refused'
    private static readonly MalformedEvent = 'intent-malformed'
    private static readonly FailedEvent = 'intent-endpoint-failed'
    private static readonly ErrorEvent = 'error'
    private static readonly DataEvent = 'data'
    private static readonly EndEvent = 'end'
    private static readonly AnyAddress = '0.0.0.0'

    private server: Server | undefined

    public constructor(private readonly applier: EnvironmentIntentApplier, private readonly callers: IAgentCallers, private readonly log: IEnvironmentIntentLog)
    {
    }

    public Listen(port: number = ConsoleIntentLink.Port, bind: string = EnvironmentIntentEndpoint.AnyAddress): Promise<void>
    {
        const server = createServer((req, res) =>
        {
            void this.Serve(req, res)
        })
        // Creating an environment takes minutes: the agent waits up to ConsoleIntentLink.TimeoutMs.
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
            if (path !== ConsoleIntentLink.Path)
            {
                req.resume()
                E.Write(res, E.StatusNotFound, E.NotFoundBody)
                return
            }
            if (req.method !== E.Post)
            {
                req.resume()
                E.Write(res, E.StatusMethodNotAllowed, E.MethodBody)
                return
            }
            if (!await this.callers.IsAgent(req.headers.authorization))
            {
                req.resume()
                this.log.Event(E.CallerRefusedEvent)
                E.Refuse(res, ConsoleIntentRefusal.NotAgent)
                return
            }
            const text = await E.ReadBody(req)
            if (text === undefined)
            {
                E.Write(res, E.StatusTooLarge, E.TooLargeBody)
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
