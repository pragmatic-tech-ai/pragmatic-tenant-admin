import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
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

/**
 * A role password as PostgreSQL stores it (RFC 5802/7677 SCRAM-SHA-256: 4096 iterations, a random 16-byte salt): what the
 * provisioner sends instead of the password, so even a statement or parameter that reaches a log carries no password.
 */
export class ScramVerifier
{
    public static readonly Iterations = 4096
    private static readonly SaltBytes = 16
    private static readonly KeyBytes = 32
    private static readonly Digest = 'sha256'
    private static readonly Base64 = 'base64'
    private static readonly ClientKeyText = 'Client Key'
    private static readonly ServerKeyText = 'Server Key'
    private static readonly Prefix = 'SCRAM-SHA-256$'
    private static readonly IterationsSeparator = ':'
    private static readonly SaltSeparator = '$'
    private static readonly KeySeparator = ':'

    private constructor()
    {
    }

    /** `SCRAM-SHA-256$4096:<salt>$<StoredKey>:<ServerKey>` (ASCII passwords, as the console mints them: SASLprep is the identity). */
    public static Of(password: string, salt: Buffer = randomBytes(ScramVerifier.SaltBytes)): string
    {
        const V = ScramVerifier
        const salted = pbkdf2Sync(password, salt, V.Iterations, V.KeyBytes, V.Digest)
        const clientKey = createHmac(V.Digest, salted).update(V.ClientKeyText).digest()
        const storedKey = createHash(V.Digest).update(clientKey).digest()
        const serverKey = createHmac(V.Digest, salted).update(V.ServerKeyText).digest()
        return V.Prefix + V.Iterations + V.IterationsSeparator + salt.toString(V.Base64) + V.SaltSeparator + storedKey.toString(V.Base64) + V.KeySeparator + serverKey.toString(V.Base64)
    }
}

/** Waits between two provisioning attempts. */
export interface IProvisionWait
{
    Wait(ms: number): Promise<void>
}

export class TimerProvisionWait implements IProvisionWait
{
    public Wait(ms: number): Promise<void>
    {
        return new Promise<void>(resolve => setTimeout(resolve, ms))
    }
}

/** What Ensure provisioned (the role password stays with the caller and the environment's Secret). */
export type HiveDatabase = { readonly Database: string; readonly Role: string }

/**
 * Provisions environments on the hive's one `pragmatic-postgres` with its superuser session, the way the image's reconcile
 * does for its applications file (an applications-file change needs a Postgres restart): role `env_<name>` (LOGIN, no other
 * privilege) with the caller's password, database `env_<name>` owned by it, `REVOKE ALL ... FROM PUBLIC` and `GRANT
 * CONNECT, TEMPORARY`. Idempotent; a failed attempt (Postgres restarting mid-way) is retried a few times before Ensure
 * gives up, and a later bring-up resumes wherever it stopped. The password never reaches the server: its SCRAM verifier does,
 * as a bind parameter set into a transaction-local setting the `DO` block reads, with statement and parameter logging off
 * for that transaction, so no statement text (`pg_stat_activity`, the server log) and no logged parameter carries it. Names
 * are `env_<name>` identifiers (EnvironmentHiveDatabase.NameOf), quoted.
 */
export class HivePostgresProvisioner implements IEnvironmentDatabaseProvisioner
{
    public static readonly PasswordSetting = 'pragmatic.role_password'
    public static readonly RoleSetting = 'pragmatic.role_name'
    private static readonly SetSettingSql = 'SELECT set_config($1, $2, true)'
    /** No statement, duration or parameter of the role transaction reaches the server log (a superuser may set these). */
    private static readonly QuietLoggingSql: readonly string[] = [
        'SET LOCAL log_statement = \'none\'',
        'SET LOCAL log_min_duration_statement = -1',
        'SET LOCAL log_parameter_max_length = 0',
        'SET LOCAL log_parameter_max_length_on_error = 0',
    ]
    private static readonly EnsureRoleSql = `DO $pragmatic$
DECLARE
    role_name text := current_setting('pragmatic.role_name');
    secret text := current_setting('pragmatic.role_password');
BEGIN
    IF secret = '' THEN
        RAISE EXCEPTION 'pragmatic: the role password is empty';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = role_name) THEN
        BEGIN
            EXECUTE format('CREATE ROLE %I', role_name);
        EXCEPTION WHEN duplicate_object THEN
            NULL;
        END;
    END IF;
    EXECUTE format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', role_name, secret);
END
$pragmatic$`
    public static readonly Attempts = 5
    public static readonly RetryMs = 2000
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
    private static readonly BadRolePrefix = 'not a PostgreSQL role name: '
    private static readonly NoTransactions = 'the hive Postgres session must support transactions (the role password is a transaction-local setting)'

    public constructor(private readonly superuser: ISqlSession, private readonly wait: IProvisionWait = new TimerProvisionWait())
    {
    }

    public async Ensure(environmentName: string, password: string): Promise<void>
    {
        await this.EnsureDatabase(environmentName, password)
    }

    /** Ensure, answering the database and role names; retried on failure (a database owned by another role is final). */
    public async EnsureDatabase(environmentName: string, password: string): Promise<HiveDatabase>
    {
        const P = HivePostgresProvisioner
        for (let attempt = 1; ; attempt++)
        {
            try
            {
                return await this.EnsureOnce(environmentName, password)
            }
            catch (error)
            {
                if (error instanceof HiveDatabaseOwnedError || attempt >= P.Attempts)
                {
                    throw error
                }
                await this.wait.Wait(P.RetryMs)
            }
        }
    }

    private async EnsureOnce(environmentName: string, password: string): Promise<HiveDatabase>
    {
        const P = HivePostgresProvisioner
        const name = EnvironmentHiveDatabase.NameOf(environmentName)
        const quoted = P.Quoted(name)
        await this.EnsureRole(name, password)
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

    /**
     * A login role with no other privilege and `password` (its SCRAM verifier, with statement and parameter logging off),
     * created when absent; the password set again either way. `role` must be a PostgreSQL identifier.
     */
    public async EnsureRole(role: string, password: string): Promise<void>
    {
        const P = HivePostgresProvisioner
        if (!EnvironmentHiveDatabase.NamePattern.test(role))
        {
            throw new Error(P.BadRolePrefix + role)
        }
        const transaction = this.superuser.Transaction?.bind(this.superuser)
        if (transaction === undefined)
        {
            throw new Error(P.NoTransactions)
        }
        await transaction(async tx =>
        {
            for (const quiet of P.QuietLoggingSql)
            {
                await tx.Execute(quiet, P.NoParams)
            }
            await tx.Query(P.SetSettingSql, [P.RoleSetting, role])
            await tx.Query(P.SetSettingSql, [P.PasswordSetting, ScramVerifier.Of(password)])
            await tx.Execute(P.EnsureRoleSql, P.NoParams)
        })
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
