import {
    IntentDecisionRefusal, IntentInternalLink, KeptIntentListing, KeptIntentView, ProtocolDecodeError, type IntentDecisionCall,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { AgentApiTransport, type AgentApiReply } from '../enrolment/agent-api-transport.js'

/** The agent refused a decision or a listing, or could not be asked: the code the portal shows a fixed message for. */
export class HiveIntentsClientError extends Error
{
    private static readonly ErrorName = 'HiveIntentsClientError'
    private static readonly Prefix = 'hive intents: '

    public constructor(public readonly Code: IntentDecisionRefusal)
    {
        super(HiveIntentsClientError.Prefix + Code)
        this.name = HiveIntentsClientError.ErrorName
    }
}

/** How the console reads and decides its hive's kept intents. */
export interface IHiveIntentsAgent
{
    List(): Promise<KeptIntentListing>
    Decide(intentId: string, call: IntentDecisionCall): Promise<KeptIntentView>
}

/**
 * The engine console's client of its hive agent's intent routes (C3.4): `GET /internal/intents` and `POST
 * /internal/intents/<id>/decision` on the agent's internal API, with the console's projected token. The console never
 * holds the hive key: the agent signs the decision. A refusal is its IntentDecisionRefusal code; anything else
 * (unreachable, a deadline, an answer that is not ours) is `unavailable`.
 */
export class HiveIntentsClient implements IHiveIntentsAgent
{
    /** A decision is sent to the platform before the agent answers (30 s channel deadline); approving may start applying. */
    public static readonly TimeoutMs = 40_000
    /** A listing holds up to 500 intents. */
    private static readonly MaxReplyBytes = 2_097_152
    private static readonly StatusOk = 200
    private readonly transport: AgentApiTransport

    public constructor(agentUrl: string, tokenFile: string, timeoutMs: number = HiveIntentsClient.TimeoutMs)
    {
        this.transport = new AgentApiTransport(agentUrl, tokenFile, timeoutMs, HiveIntentsClient.MaxReplyBytes)
    }

    public async List(): Promise<KeptIntentListing>
    {
        const reply = await this.transport.Call(AgentApiTransport.Get, IntentInternalLink.IntentsPath, undefined)
        return HiveIntentsClient.Read(reply, json => KeptIntentListing.Parse(json))
    }

    public async Decide(intentId: string, call: IntentDecisionCall): Promise<KeptIntentView>
    {
        const reply = await this.transport.Call(AgentApiTransport.Post, IntentInternalLink.DecisionPath(intentId), JSON.stringify(call.ToJson()))
        return HiveIntentsClient.Read(reply, json => KeptIntentView.Parse(json))
    }

    private static Read<T>(reply: AgentApiReply | undefined, parse: (json: unknown) => T): T
    {
        if (reply === undefined)
        {
            throw new HiveIntentsClientError(IntentDecisionRefusal.Unavailable)
        }
        if (reply.Status !== HiveIntentsClient.StatusOk)
        {
            throw new HiveIntentsClientError(IntentInternalLink.CodeOf(reply.Json) ?? IntentDecisionRefusal.Unavailable)
        }
        try
        {
            return parse(reply.Json)
        }
        catch (error)
        {
            if (error instanceof ProtocolDecodeError)
            {
                throw new HiveIntentsClientError(IntentDecisionRefusal.Unavailable)
            }
            throw error
        }
    }
}
