import { AgentInternalLink, HiveEnrolmentRefusal, HiveEnrolmentStatus, ProtocolDecodeError, type HiveEnrolmentCall } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { AgentApiTransport } from './agent-api-transport.js'

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
    private static readonly StatusOk = 200
    private static readonly MaxReplyBytes = 16_384
    private readonly transport: AgentApiTransport

    public constructor(agentUrl: string, tokenFile: string, timeoutMs: number = HiveEnrolmentClient.TimeoutMs)
    {
        this.transport = new AgentApiTransport(agentUrl, tokenFile, timeoutMs, HiveEnrolmentClient.MaxReplyBytes)
    }

    public Enrol(call: HiveEnrolmentCall): Promise<HiveEnrolmentStatus>
    {
        return this.Send(AgentApiTransport.Post, AgentInternalLink.EnrolPath, JSON.stringify(call.ToJson()))
    }

    public Status(): Promise<HiveEnrolmentStatus>
    {
        return this.Send(AgentApiTransport.Get, AgentInternalLink.EnrolmentPath, undefined)
    }

    private async Send(method: string, path: string, body: string | undefined): Promise<HiveEnrolmentStatus>
    {
        const reply = await this.transport.Call(method, path, body)
        if (reply === undefined)
        {
            throw new HiveEnrolmentClientError(HiveEnrolmentRefusal.Unavailable)
        }
        if (reply.Status !== HiveEnrolmentClient.StatusOk)
        {
            throw new HiveEnrolmentClientError(AgentInternalLink.CodeOf(reply.Json) ?? HiveEnrolmentRefusal.Unavailable)
        }
        try
        {
            return HiveEnrolmentStatus.Parse(reply.Json)
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
}
