/** The level a chart-installed management engine runs at (the chart value `level`). */
export enum EngineMode
{
    /** The hive agent is installed and idle until the hive is enrolled (C3.3); the console offers "connect this hive". */
    Connected = 'connected',
    /** No agent, no agent channel, no dial-home: the console never contacts Pragmatic. */
    Standalone = 'standalone',
}

/**
 * The console's engine-install settings, set by the `pragmatic-engine` chart only (a push-installed console sets none):
 * the mode, the hive Postgres superuser URL file, and the release images environments run on. Platform-owned, so the
 * component descriptor leaves them out (C3.1 ruling) and no tenant configuration can change them.
 */
export class EngineEnv
{
    public static readonly Mode = 'PRAGMATIC_ENGINE_MODE'
    /** The hive Postgres superuser URL file: environments are provisioned on the hive's one Postgres (C3.2 Task 5). */
    public static readonly HivePostgresUrlFile = 'PRAGMATIC_TENANT_ADMIN_HIVE_POSTGRES_URL_FILE'
    public static readonly EnvServerImage = 'PRAGMATIC_TENANT_ADMIN_ENV_SERVER_IMAGE'
    public static readonly UiUnpackImage = 'PRAGMATIC_TENANT_ADMIN_UI_UNPACK_IMAGE'
    /** The chart's `ingress.className` (empty: the cluster's default class): what every environment's Ingress names. */
    public static readonly IngressClass = 'PRAGMATIC_TENANT_ADMIN_INGRESS_CLASS'
    /** The folder of the Owner's initial sign-in (files `email`, `password`), seeded into the realm at start. */
    public static readonly OwnerInitialDir = 'PRAGMATIC_TENANT_ADMIN_OWNER_INITIAL_DIR'
    private static readonly UnknownModePrefix = 'PRAGMATIC_ENGINE_MODE has an unknown value: '
    private static readonly Empty = ''

    private constructor()
    {
    }

    /** The chart's mode, or undefined for a console the platform pushed (no chart). An unknown value refuses the start. */
    public static ModeOf(env: NodeJS.ProcessEnv): EngineMode | undefined
    {
        const raw = env[EngineEnv.Mode]?.trim() ?? EngineEnv.Empty
        if (raw === EngineEnv.Empty)
        {
            return undefined
        }
        if (!Object.values(EngineMode).includes(raw as EngineMode))
        {
            throw new Error(EngineEnv.UnknownModePrefix + raw)
        }
        return raw as EngineMode
    }

    public static OptionalOf(env: NodeJS.ProcessEnv, name: string): string | undefined
    {
        const value = env[name]?.trim()
        return value === undefined || value === EngineEnv.Empty ? undefined : value
    }
}
