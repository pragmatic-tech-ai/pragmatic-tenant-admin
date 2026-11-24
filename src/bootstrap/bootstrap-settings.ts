/** Where the console's certificate comes from (the chart value `tls.mode`). */
export enum EngineTlsMode
{
    Secret = 'secret',
    SelfSigned = 'self-signed',
}

/** What the chart hands the bootstrap Job (`PRAGMATIC_BOOTSTRAP_*`); every value is public, none is a secret. */
export class BootstrapSettings
{
    public static readonly NamespaceEnv = 'PRAGMATIC_BOOTSTRAP_NAMESPACE'
    public static readonly IdpNamespaceEnv = 'PRAGMATIC_BOOTSTRAP_IDP_NAMESPACE'
    public static readonly TenantIdEnv = 'PRAGMATIC_BOOTSTRAP_TENANT_ID'
    public static readonly TenantNameEnv = 'PRAGMATIC_BOOTSTRAP_TENANT_NAME'
    public static readonly HiveIdEnv = 'PRAGMATIC_BOOTSTRAP_HIVE_ID'
    public static readonly HiveLabelEnv = 'PRAGMATIC_BOOTSTRAP_HIVE_LABEL'
    public static readonly ConsoleHostEnv = 'PRAGMATIC_BOOTSTRAP_CONSOLE_HOST'
    public static readonly BaseDomainEnv = 'PRAGMATIC_BOOTSTRAP_BASE_DOMAIN'
    public static readonly IdpHostEnv = 'PRAGMATIC_BOOTSTRAP_IDP_HOST'
    public static readonly IdpInternalHostEnv = 'PRAGMATIC_BOOTSTRAP_IDP_INTERNAL_HOST'
    public static readonly LevelEnv = 'PRAGMATIC_BOOTSTRAP_LEVEL'
    public static readonly TlsModeEnv = 'PRAGMATIC_BOOTSTRAP_TLS_MODE'
    public static readonly TlsSecretEnv = 'PRAGMATIC_BOOTSTRAP_TLS_SECRET'
    public static readonly OwnerEmailEnv = 'PRAGMATIC_BOOTSTRAP_OWNER_EMAIL'
    private static readonly MissingPrefix = 'missing required environment variable '
    private static readonly BadModePrefix = 'PRAGMATIC_BOOTSTRAP_TLS_MODE has an unknown value: '
    private static readonly NoTlsSecret = 'tls.mode=secret needs tls.secretName (PRAGMATIC_BOOTSTRAP_TLS_SECRET)'
    private static readonly Empty = ''
    private static readonly StandaloneLevel = 'standalone'

    private constructor(
        public readonly Namespace: string,
        public readonly IdpNamespace: string,
        public readonly TenantId: string,
        public readonly TenantName: string,
        public readonly HiveId: string,
        public readonly HiveLabel: string,
        public readonly ConsoleHost: string,
        public readonly BaseDomain: string,
        public readonly IdpHost: string,
        public readonly IdpInternalHost: string,
        public readonly Standalone: boolean,
        public readonly Tls: EngineTlsMode,
        public readonly TlsSecret: string | undefined,
        public readonly OwnerEmail: string,
    )
    {
        Object.freeze(this)
    }

    public get SelfSigned(): boolean
    {
        return this.Tls === EngineTlsMode.SelfSigned
    }

    public static From(env: NodeJS.ProcessEnv): BootstrapSettings
    {
        const S = BootstrapSettings
        const raw = S.Optional(env, S.TlsModeEnv) ?? EngineTlsMode.Secret
        if (!Object.values(EngineTlsMode).includes(raw as EngineTlsMode))
        {
            throw new Error(S.BadModePrefix + raw)
        }
        const tls = raw as EngineTlsMode
        const tlsSecret = S.Optional(env, S.TlsSecretEnv)
        if (tls === EngineTlsMode.Secret && tlsSecret === undefined)
        {
            throw new Error(S.NoTlsSecret)
        }
        const tenantId = S.Required(env, S.TenantIdEnv)
        const hiveId = S.Required(env, S.HiveIdEnv)
        return new BootstrapSettings(
            S.Required(env, S.NamespaceEnv),
            S.Required(env, S.IdpNamespaceEnv),
            tenantId,
            S.Optional(env, S.TenantNameEnv) ?? tenantId,
            hiveId,
            S.Optional(env, S.HiveLabelEnv) ?? hiveId,
            S.Required(env, S.ConsoleHostEnv),
            S.Required(env, S.BaseDomainEnv),
            S.Required(env, S.IdpHostEnv),
            S.Required(env, S.IdpInternalHostEnv),
            S.Optional(env, S.LevelEnv) === S.StandaloneLevel,
            tls,
            tls === EngineTlsMode.Secret ? tlsSecret : undefined,
            S.Required(env, S.OwnerEmailEnv),
        )
    }

    private static Optional(env: NodeJS.ProcessEnv, name: string): string | undefined
    {
        const value = env[name]?.trim()
        return value === undefined || value === BootstrapSettings.Empty ? undefined : value
    }

    private static Required(env: NodeJS.ProcessEnv, name: string): string
    {
        const value = BootstrapSettings.Optional(env, name)
        if (value === undefined)
        {
            throw new Error(BootstrapSettings.MissingPrefix + name)
        }
        return value
    }
}
