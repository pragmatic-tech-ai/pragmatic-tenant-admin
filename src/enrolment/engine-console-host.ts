import type { RouteTable } from '@pragmatic-tech-ai/pragmatic-app-host'
import { ConsoleAddressOption } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { TenantAdminEnv, TenantConsoleHost, type TenantConsoleHostOptions } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { EngineEnv, EngineMode } from '../engine-mode.js'
import { EngineConsoleAddress, EnrolmentRoutes } from './enrolment-routes.js'
import { HiveEnrolmentClient } from './hive-enrolment-client.js'

/** A connected engine's enrolment setting is missing or wrong (names the setting, never a value). */
export class EngineEnrolmentSettingError extends Error
{
    private static readonly ErrorName = 'EngineEnrolmentSettingError'
    private static readonly Separator = ': '

    public constructor(setting: string, reason: string)
    {
        super(setting + EngineEnrolmentSettingError.Separator + reason)
        this.name = EngineEnrolmentSettingError.ErrorName
    }
}

/**
 * The tenant console host of a connected engine (C3.3): the shared console's routes plus "connect this hive"
 * (EnrolmentRoutes). A standalone engine and a console the platform pushed have no such routes (404: no connect page).
 */
export class EngineConsoleHost extends TenantConsoleHost
{
    private static readonly Missing = 'is required for a connected engine'
    /** The chart's mount of the console's projected token for the agent. */
    public static readonly DefaultAgentTokenFile = '/var/run/secrets/pragmatic-hive-agent/token'
    private static readonly BadOption = 'must be own-domain, hive-subdomain or relayed-hive-subdomain'

    public constructor(options: TenantConsoleHostOptions, private readonly enrolment: EnrolmentRoutes)
    {
        super(options)
    }

    /** The enrolment routes a connected engine's settings name; undefined for any other console. */
    public static EnrolmentRoutesOf(env: NodeJS.ProcessEnv): EnrolmentRoutes | undefined
    {
        const E = EngineConsoleHost
        // A connected engine the chart lets its console enrol names the agent's URL; a hosted one (the host agent enrols
        // it) and every other console do not.
        const agentUrl = EngineEnv.OptionalOf(env, EngineEnv.AgentUrl)
        if (EngineEnv.ModeOf(env) !== EngineMode.Connected || agentUrl === undefined)
        {
            return undefined
        }
        const option = EngineEnv.OptionalOf(env, EngineEnv.ConsoleAddress) ?? ConsoleAddressOption.OwnDomain
        if (!EngineConsoleAddress.Options.includes(option as ConsoleAddressOption))
        {
            throw new EngineEnrolmentSettingError(EngineEnv.ConsoleAddress, E.BadOption)
        }
        const client = new HiveEnrolmentClient(agentUrl, EngineEnv.OptionalOf(env, EngineEnv.AgentTokenFile) ?? E.DefaultAgentTokenFile)
        return new EnrolmentRoutes(client, new EngineConsoleAddress(option as ConsoleAddressOption, E.Required(env, TenantAdminEnv.ConsoleHost)))
    }

    public override Routes(): RouteTable
    {
        const table = super.Routes()
        this.enrolment.Register(table)
        return table
    }

    private static Required(env: NodeJS.ProcessEnv, name: string): string
    {
        const value = EngineEnv.OptionalOf(env, name)
        if (value === undefined)
        {
            throw new EngineEnrolmentSettingError(name, EngineConsoleHost.Missing)
        }
        return value
    }
}
