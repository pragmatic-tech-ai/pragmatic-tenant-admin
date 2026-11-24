import { readFileSync } from 'node:fs'

/** One answer of the hive agent's internal API: its status and its JSON body (null when it was not JSON). */
export class AgentApiReply
{
    public constructor(public readonly Status: number, public readonly Json: unknown)
    {
    }
}

/**
 * The console's calls to its hive agent's internal API (C3.3, C3.4): a request to the agent's ClusterIP Service with
 * the console's projected service-account token for the audience `pragmatic-hive-agent` (re-read on every call: the
 * kubelet rotates it), the answer read under a size limit within a deadline. Undefined when the agent could not be
 * asked or answered something that is not ours (unreadable token, unreachable, a deadline, an answer over the limit).
 */
export class AgentApiTransport
{
    public static readonly Post = 'POST'
    public static readonly Get = 'GET'
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly ContentTypeHeader = 'content-type'
    private static readonly ContentLengthHeader = 'content-length'
    private static readonly JsonType = 'application/json'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly Utf8 = 'utf8'

    public constructor(private readonly agentUrl: string, private readonly tokenFile: string, private readonly timeoutMs: number, private readonly maxReplyBytes: number)
    {
    }

    public async Call(method: string, path: string, body: string | undefined): Promise<AgentApiReply | undefined>
    {
        const A = AgentApiTransport
        let token: string
        try
        {
            token = readFileSync(this.tokenFile, A.Utf8).trim()
        }
        catch
        {
            return undefined
        }
        try
        {
            const response = await fetch(new URL(path, this.agentUrl), {
                method,
                headers: body === undefined ? { [A.AuthorizationHeader]: A.BearerPrefix + token } : { [A.AuthorizationHeader]: A.BearerPrefix + token, [A.ContentTypeHeader]: A.JsonType },
                body,
                signal: AbortSignal.timeout(this.timeoutMs),
            })
            const text = await this.ReadLimited(response)
            return text === undefined ? undefined : new AgentApiReply(response.status, A.JsonOrNull(text))
        }
        catch
        {
            return undefined
        }
    }

    /** The reply as text, or undefined when it is over the limit (by its declared length, unread, else while streaming). */
    private async ReadLimited(response: Response): Promise<string | undefined>
    {
        const A = AgentApiTransport
        const declared = Number(response.headers.get(A.ContentLengthHeader) ?? Number.NaN)
        if (Number.isFinite(declared) && declared > this.maxReplyBytes)
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
            if (size > this.maxReplyBytes)
            {
                return undefined
            }
            chunks.push(Buffer.from(chunk))
        }
        return Buffer.concat(chunks).toString(A.Utf8)
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
