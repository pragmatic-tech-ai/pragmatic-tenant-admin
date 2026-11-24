import { HttpMethod, HttpProblem, RouteAuth, type RequestContext, type RouteTable } from '@pragmatic-tech-ai/pragmatic-app-host'
import {
    AgentInternalLink, ConsoleAddress, ConsoleAddressOption, HiveEnrolmentCall, HiveEnrolmentRefusal, ProtocolDecodeError,
    type HiveEnrolmentStatus, type HiveLevel,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { TenantRoles, TenantSessionClaims } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { HiveEnrolmentClientError, type IHiveEnrolmentAgent } from './hive-enrolment-client.js'

/** Where this engine's console is reached, as the chart installed it (`console.host`, `console.address`). */
export class EngineConsoleAddress
{
    public static readonly Options: readonly ConsoleAddressOption[] = Object.values(ConsoleAddressOption)

    public constructor(public readonly Option: ConsoleAddressOption, public readonly Host: string)
    {
    }

    /** Whether enrolling needs the ingress address the platform publishes a record to (the plain hive subdomain). */
    public get NeedsIngressAddress(): boolean
    {
        return this.Option === ConsoleAddressOption.HiveSubdomain
    }

    /** The protocol's ConsoleAddress for this console; ProtocolDecodeError when the host does not fit the option. */
    public For(ingressAddress: string | null): ConsoleAddress
    {
        return ConsoleAddress.Parse({ Option: this.Option, HostName: this.Host, IngressAddress: this.NeedsIngressAddress ? ingressAddress : null })
    }
}

/**
 * "Connect this hive" on the engine console's tenant API (C3.3, level connected only): `GET /tenant-api/hive/enrolment`
 * (any session of the tenant) answers whether the hive is enrolled and as what, plus how the console is reached;
 * `POST /tenant-api/hive/enrol` (tenant role `admin`) `{ Code, Level, IngressAddress? }` asks the hive agent to enrol
 * with the one-time code from the personal cabinet. Refusals are `{ error, code }` with the agent's
 * HiveEnrolmentRefusal code (the portal shows a fixed message per code); nothing from the platform's answer travels.
 */
export class EnrolmentRoutes
{
    public static readonly EnrolmentPath = '/tenant-api/hive/enrolment'
    public static readonly EnrolPath = '/tenant-api/hive/enrol'
    private static readonly MaxBodyBytes = 4096
    private static readonly StatusOk = 200
    private static readonly StatusUnauthorized = 401
    private static readonly UnauthenticatedMessage = 'Not signed in'
    private static readonly CodeField = 'Code'
    private static readonly LevelField = 'Level'
    private static readonly IngressAddressField = 'IngressAddress'

    public constructor(private readonly agent: IHiveEnrolmentAgent, private readonly address: EngineConsoleAddress)
    {
    }

    public Register(table: RouteTable): void
    {
        const R = EnrolmentRoutes
        table.Add({ Method: HttpMethod.Get, Pattern: R.EnrolmentPath, Auth: RouteAuth.Session, Handler: ctx => this.Run(ctx, () => this.Status(ctx)) })
        table.Add({ Method: HttpMethod.Post, Pattern: R.EnrolPath, Auth: RouteAuth.Session, Role: TenantRoles.Admin, BodyLimit: R.MaxBodyBytes, Handler: ctx => this.Run(ctx, () => this.Enrol(ctx)) })
    }

    /** The status the portal reads: the agent's, with how this console is reached. */
    public View(status: HiveEnrolmentStatus): Record<string, unknown>
    {
        return { ...status.ToJson(), ConsoleAddress: { Option: this.address.Option, HostName: this.address.Host, NeedsIngressAddress: this.address.NeedsIngressAddress } }
    }

    private async Status(ctx: RequestContext): Promise<void>
    {
        ctx.WriteJson(EnrolmentRoutes.StatusOk, this.View(await this.agent.Status()))
    }

    private async Enrol(ctx: RequestContext): Promise<void>
    {
        const R = EnrolmentRoutes
        const body = await ctx.ReadJsonObject()
        const ingress = body[R.IngressAddressField]
        let call: HiveEnrolmentCall
        try
        {
            const address = this.address.For(typeof ingress === 'string' && ingress.trim() !== '' ? ingress.trim() : null)
            call = HiveEnrolmentCall.Create(R.Trimmed(body[R.CodeField]), body[R.LevelField] as HiveLevel, address)
        }
        catch (error)
        {
            if (error instanceof ProtocolDecodeError)
            {
                R.Refuse(ctx, HiveEnrolmentRefusal.Malformed)
                return
            }
            throw error
        }
        ctx.NoteAudit(call.Level)
        ctx.WriteJson(R.StatusOk, this.View(await this.agent.Enrol(call)))
    }

    /** Runs a route for a live session of the tenant; the agent's refusals are answered with their codes. */
    private async Run(ctx: RequestContext, run: () => Promise<void>): Promise<void>
    {
        const R = EnrolmentRoutes
        if (TenantSessionClaims.ViewOf(ctx.RequireSession()) === undefined)
        {
            throw new HttpProblem(R.StatusUnauthorized, R.UnauthenticatedMessage)
        }
        try
        {
            await run()
        }
        catch (error)
        {
            if (error instanceof HiveEnrolmentClientError)
            {
                // The agent refusing the console itself is the install's fault, not the admin's: unavailable.
                R.Refuse(ctx, error.Code === HiveEnrolmentRefusal.NotConsole ? HiveEnrolmentRefusal.Unavailable : error.Code)
                return
            }
            throw error
        }
    }

    private static Refuse(ctx: RequestContext, code: HiveEnrolmentRefusal): void
    {
        ctx.WriteJson(AgentInternalLink.StatusOf(code), AgentInternalLink.RefusalBody(code))
    }

    /** A code as typed: spaces around it dropped (a paste), anything else checked by the protocol's pattern. */
    private static Trimmed(value: unknown): string
    {
        return typeof value === 'string' ? value.trim() : ''
    }
}
