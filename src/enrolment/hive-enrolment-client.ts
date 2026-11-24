import { readFileSync } from 'node:fs'
import { AgentInternalLink, HiveEnrolmentRefusal, HiveEnrolmentStatus, ProtocolDecodeError, type HiveEnrolmentCall } from '@pragmatic-tech-ai/pragmatic-hive-protocol'

/** The agent refused, or could not be asked: the code the portal shows a fixed message for. */
export class HiveEnrolmentClientError extends Error
{
    private static readonly ErrorName = 'HiveEnrolmentClientError'
    private static readonly Prefix = 'hive enrolment: '

    public constructor(public readonly Code: HiveEnrolmentRefusal)
    {
        super(HiveEnrolmentClientError.Prefix + Code)
        this.name = HiveEnrolmentClientError.ErrorName
    }
}

/** How the console reaches its hive's agent. */
export interface IHiveEnrolmentAgent
{
    Enrol(call: HiveEnrolmentCall): Promise<HiveEnrolmentStatus>
    Status(): Promise<HiveEnrolmentStatus>
}

/**
 * The engine console's client of its hive agent's internal API (C3.3): `POST /internal/enrol` and `GET
 * /internal/enrolment` on the agent's ClusterIP Service, each with the console's projected service-account token for
 * the audience `pragmatic-hive-agent` (re-read on every call: the kubelet rotates it). The console never holds the hive
 * key. An answer with a refusal code is that code; anything else (unreachable, a deadline, an answer that is not ours)
 * is `unavailable`.
 */
export class HiveEnrolmentClient implements IHiveEnrolmentAgent
{
    /** The agent's channel deadline is 30 s; the console waits a little longer for its answer. */
    public static readonly TimeoutMs = 40_000
    private static readonly Post = 'POST'
    private static readonly Get = 'GET'
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly ContentTypeHeader = 'content-type'
    private static readonly ContentLengthHeader = 'content-length'
    private static readonly JsonType = 'application/json'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly Utf8 = 'utf8'
    private static readonly StatusOk = 200
    private static readonly MaxReplyBytes = 16_384

    public constructor(private readonly agentUrl: string, private readonly tokenFile: string, private readonly timeoutMs: number = HiveEnrolmentClient.TimeoutMs)
    {
    }

    public Enrol(call: HiveEnrolmentCall): Promise<HiveEnrolmentStatus>
    {
        return this.Send(HiveEnrolmentClient.Post, AgentInternalLink.EnrolPath, JSON.stringify(call.ToJson()))
    }

    public Status(): Promise<HiveEnrolmentStatus>
    {
        return this.Send(HiveEnrolmentClient.Get, AgentInternalLink.EnrolmentPath, undefined)
    }

    private async Send(method: string, path: string, body: string | undefined): Promise<HiveEnrolmentStatus>
    {
        const H = HiveEnrolmentClient
        let token: string
        try
        {
            token = readFileSync(this.tokenFile, H.Utf8).trim()
        }
        catch
        {
            throw new HiveEnrolmentClientError(HiveEnrolmentRefusal.Unavailable)
        }
        let response: Response
        let text: string | undefined
        try
        {
            response = await fetch(new URL(path, this.agentUrl), {
                method,
                headers: body === undefined ? { [H.AuthorizationHeader]: H.BearerPrefix + token } : { [H.AuthorizationHeader]: H.BearerPrefix + token, [H.ContentTypeHeader]: H.JsonType },
                body,
                signal: AbortSignal.timeout(this.timeoutMs),
            })
            text = await H.ReadLimited(response)
        }
        catch
        {
            throw new HiveEnrolmentClientError(HiveEnrolmentRefusal.Unavailable)
        }
        if (text === undefined)
        {
            throw new HiveEnrolmentClientError(HiveEnrolmentRefusal.Unavailable)
        }
        const json = H.JsonOrNull(text)
        if (response.status !== H.StatusOk)
        {
            throw new HiveEnrolmentClientError(AgentInternalLink.CodeOf(json) ?? HiveEnrolmentRefusal.Unavailable)
        }
        try
        {
            return HiveEnrolmentStatus.Parse(json)
        }
        catch (error)
        {
            if (error instanceof ProtocolDecodeError)
            {
                throw new HiveEnrolmentClientError(HiveEnrolmentRefusal.Unavailable)
            }
            throw error
        }
    }

    /** The reply as text, or undefined when it is over the limit (by its declared length, unread, else while streaming). */
    private static async ReadLimited(response: Response): Promise<string | undefined>
    {
        const H = HiveEnrolmentClient
        const declared = Number(response.headers.get(H.ContentLengthHeader) ?? Number.NaN)
        if (Number.isFinite(declared) && declared > H.MaxReplyBytes)
        {
            await response.body?.cancel()
            return undefined
        }
        if (response.body === null)
        {
            return ''
        }
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of response.body)
        {
            size += chunk.byteLength
            if (size > H.MaxReplyBytes)
            {
                return undefined
            }
            chunks.push(Buffer.from(chunk))
        }
        return Buffer.concat(chunks).toString(H.Utf8)
    }

    private static JsonOrNull(text: string): unknown
    {
        try
        {
            return JSON.parse(text) as unknown
        }
        catch
        {
            return null
        }
    }
}
