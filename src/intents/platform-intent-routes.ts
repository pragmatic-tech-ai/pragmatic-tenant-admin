import { HttpMethod, HttpProblem, RouteAuth, type RequestContext, type RouteTable } from '@pragmatic-tech-ai/pragmatic-app-host'
import {
    IntentChoice, IntentDecisionCall, IntentDecisionRefusal, IntentInternalLink, ProtocolDecodeError, ProtocolNames, RealmSubject, type KeptIntentView,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { TenantRoles, TenantSessionClaims, type TenantSession } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { HiveIntentsClientError, type IHiveIntentsAgent } from './hive-intents-client.js'

/**
 * The platform's intents in the engine console's tenant API (C3.4, level connected only): `GET /tenant-api/intents`
 * (any session of the tenant) answers the agent's KeptIntentListing; `POST /tenant-api/intents/:id/approve` and
 * `/reject` (tenant role `admin`) `{ IntentDigest }` ask the agent to sign the decision with the hive key, naming the
 * session's realm subject (the tenant's realm, the signed-in subject; never an email) as the approver, and answer the
 * intent's KeptIntentView. Refusals are `{ error, code }` with the agent's IntentDecisionRefusal code.
 */
export class PlatformIntentRoutes
{
    public static readonly IntentsPath = '/tenant-api/intents'
    public static readonly ApprovePath = '/tenant-api/intents/:id/approve'
    public static readonly RejectPath = '/tenant-api/intents/:id/reject'
    private static readonly IdParam = 'id'
    private static readonly DigestField = 'IntentDigest'
    private static readonly MaxBodyBytes = 4096
    private static readonly StatusOk = 200
    private static readonly StatusUnauthorized = 401
    private static readonly UnauthenticatedMessage = 'Not signed in'

    public constructor(private readonly agent: IHiveIntentsAgent)
    {
    }

    public Register(table: RouteTable): void
    {
        const P = PlatformIntentRoutes
        table.Add({ Method: HttpMethod.Get, Pattern: P.IntentsPath, Auth: RouteAuth.Session, Handler: ctx => this.Run(ctx, async () => ctx.WriteJson(P.StatusOk, (await this.agent.List()).ToJson())) })
        table.Add({ Method: HttpMethod.Post, Pattern: P.ApprovePath, Auth: RouteAuth.Session, Role: TenantRoles.Admin, BodyLimit: P.MaxBodyBytes, Handler: ctx => this.Run(ctx, session => this.Decide(ctx, session, IntentChoice.Approve)) })
        table.Add({ Method: HttpMethod.Post, Pattern: P.RejectPath, Auth: RouteAuth.Session, Role: TenantRoles.Admin, BodyLimit: P.MaxBodyBytes, Handler: ctx => this.Run(ctx, session => this.Decide(ctx, session, IntentChoice.Reject)) })
    }

    /** The approver a session decides as: the tenant's realm and the signed-in subject. */
    public static ApproverOf(session: TenantSession): RealmSubject
    {
        return RealmSubject.Of(session.tenantId, session.principalId)
    }

    private async Decide(ctx: RequestContext, session: TenantSession, choice: IntentChoice): Promise<void>
    {
        const P = PlatformIntentRoutes
        const intentId = ctx.Param(P.IdParam)
        const body = await ctx.ReadJsonObject()
        let call: IntentDecisionCall
        try
        {
            if (!ProtocolNames.Label.test(intentId))
            {
                P.Refuse(ctx, IntentDecisionRefusal.UnknownIntent)
                return
            }
            call = IntentDecisionCall.Create(typeof body[P.DigestField] === 'string' ? body[P.DigestField] as string : '', choice, P.ApproverOf(session))
        }
        catch (error)
        {
            if (error instanceof ProtocolDecodeError)
            {
                P.Refuse(ctx, IntentDecisionRefusal.Malformed)
                return
            }
            throw error
        }
        ctx.NoteAudit(choice)
        ctx.WriteJson(P.StatusOk, (await this.DecideOrCurrent(intentId, call)).ToJson())
    }

    /**
     * The decision, or (when the agent could not answer in time: it may be busy applying, and records the decision
     * later) the intent as the agent keeps it now, so the admin sees where it stands instead of a failure; a refusal of
     * the decision itself passes through.
     */
    private async DecideOrCurrent(intentId: string, call: IntentDecisionCall): Promise<KeptIntentView>
    {
        try
        {
            return await this.agent.Decide(intentId, call)
        }
        catch (error)
        {
            if (!(error instanceof HiveIntentsClientError) || error.Code !== IntentDecisionRefusal.Unavailable)
            {
                throw error
            }
            const current = (await this.agent.List()).Intents.find(intent => intent.IntentId === intentId)
            if (current === undefined)
            {
                throw error
            }
            return current
        }
    }

    /** Runs a route for a live session of the tenant; the agent's refusals are answered with their codes. */
    private async Run(ctx: RequestContext, run: (session: TenantSession) => Promise<void>): Promise<void>
    {
        const P = PlatformIntentRoutes
        const session = TenantSessionClaims.ViewOf(ctx.RequireSession())
        if (session === undefined)
        {
            throw new HttpProblem(P.StatusUnauthorized, P.UnauthenticatedMessage)
        }
        try
        {
            await run(session)
        }
        catch (error)
        {
            if (error instanceof HiveIntentsClientError)
            {
                // The agent refusing the console itself is the install's fault, not the admin's: unavailable.
                P.Refuse(ctx, error.Code === IntentDecisionRefusal.NotConsole ? IntentDecisionRefusal.Unavailable : error.Code)
                return
            }
            throw error
        }
    }

    private static Refuse(ctx: RequestContext, code: IntentDecisionRefusal): void
    {
        ctx.WriteJson(IntentInternalLink.StatusOf(code), IntentInternalLink.RefusalBody(code))
    }
}
