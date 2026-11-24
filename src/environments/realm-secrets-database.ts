import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { CustomRealmSecrets, PgSession, RealmSecretsGrant, RealmSecretsOption, RealmSecretsProvisioning, RealmSecretsSettings, WorkloadContext } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { PostgresPoolFactory } from '@pragmatic-tech-ai/pragmatic-realm-custom'
import type { EnvironmentRealmSecretsMaterial, IEnvironmentRealmSecretsMaterial } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { EngineEnv } from '../engine-mode.js'
import { HivePostgresProvisioner, type IProvisionWait, TimerProvisionWait } from './hive-postgres-provisioner.js'

/** The custom realm secrets home could not be provisioned. Names the SQLSTATE only, never the driver's text (roles, statements). */
export class RealmSecretsDatabaseError extends Error
{
    private static readonly ErrorName = 'RealmSecretsDatabaseError'
    private static readonly Prefix = 'the custom realm secrets home could not be provisioned on the hive Postgres (SQLSTATE '
    private static readonly NoCode = 'none'
    private static readonly Close = ')'

    public constructor(public readonly Code: string | undefined)
    {
        super(RealmSecretsDatabaseError.Prefix + (Code ?? RealmSecretsDatabaseError.NoCode) + RealmSecretsDatabaseError.Close)
        this.name = RealmSecretsDatabaseError.ErrorName
    }

    public static Of(error: unknown): RealmSecretsDatabaseError
    {
        if (error instanceof RealmSecretsDatabaseError) return error
        const code = (error as { code?: unknown } | null)?.code
        return new RealmSecretsDatabaseError(typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined)
    }
}

/** One login role of the custom realm secrets home and its minted password. */
export type RealmSecretsRole = { readonly Role: string; readonly Password: string }

/**
 * The custom option's `realm_secrets` database on the hive's `pragmatic-postgres` (2.5): the console provisions it at its
 * start, before any component opens the home, with the hive Postgres superuser (the bootstrap Job runs before Postgres
 * exists, so it only mints the roles' passwords). Three login roles, each with its minted password: the console and the
 * realm sign-in service write, the environments' servers read (`realm_secrets_environments`, one role for every
 * environment of the hive: they are all the realm's). The database belongs to the superuser; `RealmSecretsProvisioning`
 * then sets up the sealed secrets, the grants table, row-level security and the roles' privileges for the realm. Every
 * step is idempotent, so each start converges it, and nothing here touches a sealed row. A failed attempt (Postgres still
 * starting) is retried a few times; a start that still fails exits, and the pod's restart tries again.
 */
export class RealmSecretsDatabase
{
    public static readonly Database = 'realm_secrets'
    public static readonly ConsoleRole = 'realm_secrets_console'
    public static readonly IdpRole = 'realm_secrets_idp'
    public static readonly EnvironmentsRole = 'realm_secrets_environments'
    /** The files of the roles' passwords in the chart's mounted folder (`PRAGMATIC_TENANT_ADMIN_REALM_SECRETS_ROLES_DIR`). */
    public static readonly ConsoleFile = 'console'
    public static readonly IdpFile = 'idp'
    public static readonly EnvironmentsFile = 'environments'
    private static readonly OwnerSql = 'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1'
    private static readonly CreateSql = 'CREATE DATABASE "realm_secrets"'
    private static readonly RevokeSql = 'REVOKE ALL ON DATABASE "realm_secrets" FROM PUBLIC'
    /** No role creates objects in the home's schema but its owner (PostgreSQL 15 and later already revoke it; kept explicit). */
    private static readonly RevokeCreateSql = 'REVOKE CREATE ON SCHEMA public FROM PUBLIC'
    private static readonly OwnerColumn = 'owner'
    private static readonly DuplicateDatabase = '42P04'
    private static readonly ApplicationName = 'pragmatic-tenant-admin-realm-secrets'
    private static readonly Encoding = 'utf8'
    private static readonly LineEnd = /[\r\n]+$/
    private static readonly NoParams: readonly unknown[] = []
    private static readonly EmptyPassword = 'a realm secrets role password file is empty: '
    private static readonly Provisioned = 'realm secrets: the custom home is provisioned for realm '
    private static readonly NoSuperuser = 'the custom realm secrets home needs the hive Postgres superuser (PRAGMATIC_TENANT_ADMIN_HIVE_POSTGRES_URL_FILE)'

    public constructor(private readonly superuser: ISqlSession, private readonly wait: IProvisionWait = new TimerProvisionWait())
    {
    }

    /** Whether this console provisions the custom home: the chart names the custom option and mounts the roles' passwords. */
    public static Applies(env: Readonly<Record<string, string | undefined>>): boolean
    {
        return env[RealmSecretsSettings.OptionVariable] === RealmSecretsOption.Custom && EngineEnv.OptionalOf(env as NodeJS.ProcessEnv, EngineEnv.RealmSecretsRolesDir) !== undefined
    }

    /**
     * The chart's start step: provisions the custom home when `Applies`, over the hive Postgres superuser URL file, for the
     * realm `PRAGMATIC_REALM_ID`. Nothing for any other option or a console the platform pushed.
     */
    public static async EnsureFromEnvironment(env: Readonly<Record<string, string | undefined>>, log: (line: string) => void): Promise<void>
    {
        const R = RealmSecretsDatabase
        if (!R.Applies(env)) return
        const context = WorkloadContext.FromEnvironment(env)
        const rolesDir = EngineEnv.OptionalOf(env as NodeJS.ProcessEnv, EngineEnv.RealmSecretsRolesDir)!
        const urlFile = EngineEnv.OptionalOf(env as NodeJS.ProcessEnv, EngineEnv.HivePostgresUrlFile)
        if (urlFile === undefined) throw new Error(R.NoSuperuser)
        const roles = await R.ReadRoles(rolesDir)
        const server = new PgSession(await new PostgresPoolFactory({ UrlFile: urlFile, MaxConnections: 1, ApplicationName: R.ApplicationName }).Create())
        try
        {
            await new RealmSecretsDatabase(server).Ensure(roles, context.RealmId, async () => new PgSession(await new PostgresPoolFactory({ UrlFile: urlFile, MaxConnections: 1, ApplicationName: R.ApplicationName, Database: R.Database }).Create()))
        }
        finally
        {
            await server.Dispose()
        }
        log(R.Provisioned + context.RealmId)
    }

    /** The three roles from the mounted folder (one password file each). */
    public static async ReadRoles(dir: string): Promise<readonly RealmSecretsRole[]>
    {
        const R = RealmSecretsDatabase
        const read = async (file: string, role: string): Promise<RealmSecretsRole> =>
        {
            const password = (await readFile(join(dir, file), R.Encoding)).replace(R.LineEnd, '')
            if (password === '') throw new Error(R.EmptyPassword + file)
            return { Role: role, Password: password }
        }
        return [await read(R.ConsoleFile, R.ConsoleRole), await read(R.IdpFile, R.IdpRole), await read(R.EnvironmentsFile, R.EnvironmentsRole)]
    }

    /** The grant of `realm`: the console and the sign-in service write, the environments read. */
    public static GrantOf(realm: string): RealmSecretsGrant
    {
        const R = RealmSecretsDatabase
        return new RealmSecretsGrant(realm, [R.ConsoleRole, R.IdpRole], [R.EnvironmentsRole])
    }

    /** Roles, then the database (the superuser's), then the home's schema and grants in it over `open`'s session; retried. */
    public async Ensure(roles: readonly RealmSecretsRole[], realm: string, open: () => Promise<ISqlSession & { Dispose?(): Promise<void> }>): Promise<void>
    {
        for (let attempt = 1; ; attempt++)
        {
            try
            {
                await this.EnsureOnce(roles, realm, open)
                return
            }
            catch (error)
            {
                if (attempt >= HivePostgresProvisioner.Attempts) throw RealmSecretsDatabaseError.Of(error)
                await this.wait.Wait(HivePostgresProvisioner.RetryMs)
            }
        }
    }

    private async EnsureOnce(roles: readonly RealmSecretsRole[], realm: string, open: () => Promise<ISqlSession & { Dispose?(): Promise<void> }>): Promise<void>
    {
        const R = RealmSecretsDatabase
        const provisioner = new HivePostgresProvisioner(this.superuser)
        for (const role of roles)
        {
            await provisioner.EnsureRole(role.Role, role.Password)
        }
        // CREATE DATABASE cannot run in a transaction: created when absent (a concurrent create is fine), owned by the superuser.
        if ((await this.superuser.Query(R.OwnerSql, [R.Database]))[0]?.[R.OwnerColumn] === undefined)
        {
            try
            {
                await this.superuser.Execute(R.CreateSql, R.NoParams)
            }
            catch (error)
            {
                if ((error as { code?: unknown }).code !== R.DuplicateDatabase) throw error
            }
        }
        await this.superuser.Execute(R.RevokeSql, R.NoParams)
        const session = await open()
        try
        {
            await session.Execute(R.RevokeCreateSql, R.NoParams)
            await RealmSecretsProvisioning.Run(session, [RealmSecretsDatabase.GrantOf(realm)])
        }
        finally
        {
            await session.Dispose?.()
        }
    }
}

/** The custom home's reader material from the console's mounts: the environments' database URL file and the realm master key file. */
export class MountedRealmSecretsMaterial implements IEnvironmentRealmSecretsMaterial
{
    public constructor(private readonly readerUrlFile: string, private readonly masterKeyFile: string)
    {
    }

    /** From the chart's environment, or undefined when it mounts no reader URL (a cloud option, or no realm secrets home). */
    public static FromEnvironment(env: Readonly<Record<string, string | undefined>>): MountedRealmSecretsMaterial | undefined
    {
        const reader = EngineEnv.OptionalOf(env as NodeJS.ProcessEnv, EngineEnv.RealmSecretsReaderUrlFile)
        const key = env[RealmSecretsSettings.VariableOf(CustomRealmSecrets.MasterKeyFile)]
        return reader === undefined || key === undefined || key === '' ? undefined : new MountedRealmSecretsMaterial(reader, key)
    }

    public async Read(): Promise<EnvironmentRealmSecretsMaterial>
    {
        return { DatabaseUrl: await readFile(this.readerUrlFile), MasterKey: await readFile(this.masterKeyFile) }
    }
}
