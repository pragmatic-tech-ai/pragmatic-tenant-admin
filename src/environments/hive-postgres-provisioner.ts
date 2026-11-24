import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { EnvironmentHiveDatabase, type IEnvironmentDatabaseProvisioner } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

/** The environment's database exists but another role owns it: the console refuses to take it over. */
export class HiveDatabaseOwnedError extends Error
{
    private static readonly ErrorName = 'HiveDatabaseOwnedError'
    private static readonly Prefix = 'the database is owned by another role: '

    public constructor(public readonly Database: string)
    {
        super(HiveDatabaseOwnedError.Prefix + Database)
        this.name = HiveDatabaseOwnedError.ErrorName
    }
}

/** What Ensure provisioned (the role password stays with the caller and the environment's Secret). */
export type HiveDatabase = { readonly Database: string; readonly Role: string }

/**
 * Provisions environments on the hive's one `pragmatic-postgres` with its superuser session, the way the image's reconcile
 * does for its applications file (an applications-file change needs a Postgres restart): role `env_<name>` (LOGIN, no other
 * privilege) with the caller's password, database `env_<name>` owned by it, `REVOKE ALL ... FROM PUBLIC` and `GRANT
 * CONNECT, TEMPORARY`. Idempotent and safe to retry after a Postgres restart at any step. The password reaches the server
 * only as a bind parameter, set into a transaction-local setting the `DO` block reads, so it never appears in a statement
 * text (`pg_stat_activity`, the server log). Names are `env_<name>` identifiers (EnvironmentHiveDatabase.NameOf), quoted.
 */
export class HivePostgresProvisioner implements IEnvironmentDatabaseProvisioner
{
    public static readonly PasswordSetting = 'pragmatic.role_password'
    public static readonly RoleSetting = 'pragmatic.role_name'
    private static readonly SetSettingSql = 'SELECT set_config($1, $2, true)'
    private static readonly EnsureRoleSql = `DO $pragmatic$
DECLARE
    role_name text := current_setting('pragmatic.role_name');
    secret text := current_setting('pragmatic.role_password');
BEGIN
    IF secret = '' THEN
        RAISE EXCEPTION 'pragmatic: the role password is empty';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('CREATE ROLE %I', role_name);
    END IF;
    EXECUTE format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', role_name, secret);
END
$pragmatic$`
    private static readonly OwnerSql = 'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1'
    private static readonly CreateDatabasePrefix = 'CREATE DATABASE '
    private static readonly OwnerInfix = ' OWNER '
    private static readonly RevokePrefix = 'REVOKE ALL ON DATABASE '
    private static readonly FromPublicSuffix = ' FROM PUBLIC'
    private static readonly GrantPrefix = 'GRANT CONNECT, TEMPORARY ON DATABASE '
    private static readonly ToInfix = ' TO '
    private static readonly DropDatabasePrefix = 'DROP DATABASE IF EXISTS '
    private static readonly DropDatabaseSuffix = ' WITH (FORCE)'
    private static readonly DropRolePrefix = 'DROP ROLE IF EXISTS '
    private static readonly Quote = '"'
    private static readonly OwnerColumn = 'owner'
    /** SQLSTATE duplicate_database: a concurrent create won the race; the owner check below decides. */
    private static readonly DuplicateDatabase = '42P04'
    private static readonly NoParams: readonly unknown[] = []
    private static readonly NoTransactions = 'the hive Postgres session must support transactions (the role password is a transaction-local setting)'

    public constructor(private readonly superuser: ISqlSession)
    {
    }

    public async Ensure(environmentName: string, password: string): Promise<void>
    {
        await this.EnsureDatabase(environmentName, password)
    }

    /** Ensure, answering the database and role names (the tests' view of it). */
    public async EnsureDatabase(environmentName: string, password: string): Promise<HiveDatabase>
    {
        const P = HivePostgresProvisioner
        const name = EnvironmentHiveDatabase.NameOf(environmentName)
        const quoted = P.Quoted(name)
        const transaction = this.superuser.Transaction?.bind(this.superuser)
        if (transaction === undefined)
        {
            throw new Error(P.NoTransactions)
        }
        await transaction(async tx =>
        {
            await tx.Query(P.SetSettingSql, [P.RoleSetting, name])
            await tx.Query(P.SetSettingSql, [P.PasswordSetting, password])
            await tx.Execute(P.EnsureRoleSql, P.NoParams)
        })
        // CREATE DATABASE cannot run in a transaction: created when absent, then its owner checked either way.
        if (await this.OwnerOf(name) === undefined)
        {
            try
            {
                await this.superuser.Execute(P.CreateDatabasePrefix + quoted + P.OwnerInfix + quoted, P.NoParams)
            }
            catch (error)
            {
                if ((error as { code?: unknown }).code !== P.DuplicateDatabase)
                {
                    throw error
                }
            }
        }
        const owner = await this.OwnerOf(name)
        if (owner !== name)
        {
            throw new HiveDatabaseOwnedError(name)
        }
        await this.superuser.Execute(P.RevokePrefix + quoted + P.FromPublicSuffix, P.NoParams)
        await this.superuser.Execute(P.GrantPrefix + quoted + P.ToInfix + quoted, P.NoParams)
        return { Database: name, Role: name }
    }

    /** Drops the environment's database (closing its sessions) and its role; on the environment's deletion only. */
    public async Drop(environmentName: string): Promise<void>
    {
        const P = HivePostgresProvisioner
        const quoted = P.Quoted(EnvironmentHiveDatabase.NameOf(environmentName))
        await this.superuser.Execute(P.DropDatabasePrefix + quoted + P.DropDatabaseSuffix, P.NoParams)
        await this.superuser.Execute(P.DropRolePrefix + quoted, P.NoParams)
    }

    private async OwnerOf(database: string): Promise<string | undefined>
    {
        const rows = await this.superuser.Query(HivePostgresProvisioner.OwnerSql, [database])
        const owner = rows[0]?.[HivePostgresProvisioner.OwnerColumn]
        return typeof owner === 'string' ? owner : undefined
    }

    /** `"<name>"`: safe because NameOf only answers `[a-z_][a-z0-9_]{0,62}`. */
    private static Quoted(name: string): string
    {
        return HivePostgresProvisioner.Quote + name + HivePostgresProvisioner.Quote
    }
}
