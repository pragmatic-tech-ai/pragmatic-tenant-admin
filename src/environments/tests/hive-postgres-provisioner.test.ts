import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { describe, it } from 'node:test'
import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PgSession } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { PostgresPoolFactory } from '@pragmatic-tech-ai/pragmatic-realm-custom'
import { HiveDatabaseOwnedError, HivePostgresProvisioner, ScramVerifier, type IProvisionWait } from '../hive-postgres-provisioner.js'

class NoWait implements IProvisionWait
{
    public Waits = 0

    public async Wait(): Promise<void>
    {
        this.Waits++
    }
}

/** Records every statement with its parameters; answers the owner lookup from a table. */
class RecordingSession
{
    public readonly Statements: Array<{ sql: string; params: readonly unknown[] }> = []
    public readonly Owners = new Map<string, string>()

    public async Query(sql: string, params: readonly unknown[]): Promise<readonly SqlRow[]>
    {
        this.Statements.push({ sql, params })
        if (sql.includes('pg_database'))
        {
            const owner = this.Owners.get(String(params[0]))
            return owner === undefined ? [] : [{ owner }]
        }
        return []
    }

    public async Execute(sql: string, params: readonly unknown[]): Promise<number>
    {
        this.Statements.push({ sql, params })
        const create = /^CREATE DATABASE "([a-z0-9_]+)" OWNER "([a-z0-9_]+)"$/.exec(sql)
        if (create !== null)
        {
            this.Owners.set(create[1], create[2])
        }
        return 0
    }

    public async Transaction<T>(work: (tx: ISqlSession) => Promise<T>): Promise<T>
    {
        return await work(this as unknown as ISqlSession)
    }

    public get Session(): ISqlSession
    {
        return this as unknown as ISqlSession
    }
}

class ProvisionerFixture
{
    public static readonly Password = 'p4ss-w0rd-that-must-never-show'
    /** The superuser URL of a disposable pragmatic-postgres (hive-laptop: the test run starts one). */
    public static readonly LiveUrl = process.env.PRAGMATIC_TEST_HIVE_PG_SUPERUSER_URL
    /** The docker container of that Postgres, for the restart test. */
    public static readonly LiveContainer = process.env.PRAGMATIC_TEST_HIVE_PG_CONTAINER

    /** A session over `url` (the factory reads the URL from a file, as the console does). */
    public static async Open(url: string = ProvisionerFixture.LiveUrl as string): Promise<PgSession>
    {
        const dir = mkdtempSync(join(tmpdir(), 'hive-pg-'))
        try
        {
            const file = join(dir, 'database-url')
            writeFileSync(file, url)
            return new PgSession(await new PostgresPoolFactory({ UrlFile: file, ApplicationName: 'provisioner-test' }).Create())
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }

    public static async Scalar(url: string, sql: string, params: unknown[] = []): Promise<unknown>
    {
        const session = await ProvisionerFixture.Open(url)
        try
        {
            const rows = await session.Query(sql, params)
            return rows[0] === undefined ? undefined : Object.values(rows[0])[0]
        }
        finally
        {
            await session.Dispose()
        }
    }

    public static RoleUrl(environment: string, password: string): string
    {
        const url = new URL(ProvisionerFixture.LiveUrl as string)
        const name = 'env_' + environment.replace(/-/g, '_')
        url.username = name
        url.password = password
        url.pathname = '/' + name
        return url.toString()
    }

    public static async WaitReady(url: string): Promise<void>
    {
        for (let i = 0; i < 60; i++)
        {
            try
            {
                await ProvisionerFixture.Scalar(url, 'SELECT 1')
                return
            }
            catch
            {
                await new Promise(resolve => setTimeout(resolve, 1000))
            }
        }
        throw new Error('the test Postgres did not come back')
    }
}

describe('HivePostgresProvisioner', () =>
{
    it('Ensure twice creates once, and the password travels only as a parameter', async () =>
    {
        const session = new RecordingSession()
        const provisioner = new HivePostgresProvisioner(session.Session)
        assert.deepEqual(await provisioner.EnsureDatabase('sales-eu', ProvisionerFixture.Password), { Database: 'env_sales_eu', Role: 'env_sales_eu' })
        await provisioner.EnsureDatabase('sales-eu', ProvisionerFixture.Password)
        assert.equal(session.Statements.filter(s => s.sql.startsWith('CREATE DATABASE')).length, 1)
        assert.ok(session.Statements.every(s => !s.sql.includes(ProvisionerFixture.Password)), 'never in a statement text')
        assert.ok(session.Statements.every(s => !s.params.includes(ProvisionerFixture.Password)), 'never as a parameter: its SCRAM verifier is sent')
        assert.ok(session.Statements.some(s => s.params.some(p => typeof p === 'string' && p.startsWith('SCRAM-SHA-256$4096:'))))
        assert.ok(session.Statements.some(s => s.sql === "SET LOCAL log_parameter_max_length = 0"), 'parameter logging off for the role transaction')
        assert.ok(session.Statements.some(s => s.sql === 'REVOKE ALL ON DATABASE "env_sales_eu" FROM PUBLIC'))
        assert.ok(session.Statements.some(s => s.sql === 'GRANT CONNECT, TEMPORARY ON DATABASE "env_sales_eu" TO "env_sales_eu"'))
    })

    it('the SCRAM verifier is the RFC 7677 one', () =>
    {
        // RFC 7677 section 3: user "user", password "pencil", salt W22ZaJ0SNY7soEsUEjb6gQ== (4096 iterations).
        assert.equal(ScramVerifier.Of('pencil', Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64')),
            'SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=')
    })

    it('a failed attempt is retried; a database owned by another role refuses at once', async () =>
    {
        const flaky = new RecordingSession()
        let failures = 2
        const original = flaky.Query.bind(flaky)
        flaky.Query = async (sql: string, params: readonly unknown[]) =>
        {
            if (sql.includes('pg_database') && failures-- > 0)
            {
                throw new Error('Connection terminated unexpectedly')
            }
            return await original(sql, params)
        }
        const wait = new NoWait()
        await new HivePostgresProvisioner(flaky.Session, wait).Ensure('sales-eu', ProvisionerFixture.Password)
        assert.equal(wait.Waits, 2)
        const session = new RecordingSession()
        session.Owners.set('env_sales_eu', 'someone_else')
        const refused = new NoWait()
        await assert.rejects(new HivePostgresProvisioner(session.Session, refused).Ensure('sales-eu', ProvisionerFixture.Password), HiveDatabaseOwnedError)
        assert.equal(refused.Waits, 0)
        assert.equal(session.Statements.filter(s => s.sql.startsWith('GRANT')).length, 0)
    })

    it('Drop removes the database (closing its sessions) and the role', async () =>
    {
        const session = new RecordingSession()
        await new HivePostgresProvisioner(session.Session).Drop('sales-eu')
        assert.deepEqual(session.Statements.map(s => s.sql), ['DROP DATABASE IF EXISTS "env_sales_eu" WITH (FORCE)', 'DROP ROLE IF EXISTS "env_sales_eu"'])
    })

    it('live: Ensure twice creates once; the role signs in; the password never appears in pg_stat_activity text', { skip: ProvisionerFixture.LiveUrl === undefined }, async () =>
    {
        const session = await ProvisionerFixture.Open()
        try
        {
            const provisioner = new HivePostgresProvisioner(session)
            await provisioner.Drop('live-one')
            await provisioner.Ensure('live-one', ProvisionerFixture.Password)
            await provisioner.Ensure('live-one', ProvisionerFixture.Password)
            const url = ProvisionerFixture.LiveUrl as string
            assert.equal(await ProvisionerFixture.Scalar(url, 'SELECT count(*)::int FROM pg_database WHERE datname = $1', ['env_live_one']), 1)
            assert.equal(await ProvisionerFixture.Scalar(ProvisionerFixture.RoleUrl('live-one', ProvisionerFixture.Password), 'SELECT current_user'), 'env_live_one')
            const leaked = await ProvisionerFixture.Scalar(url, 'SELECT count(*)::int FROM pg_stat_activity WHERE query LIKE $1', ['%' + ProvisionerFixture.Password + '%'])
            assert.equal(leaked, 0)
            await provisioner.Drop('live-one')
            assert.equal(await ProvisionerFixture.Scalar(url, 'SELECT count(*)::int FROM pg_roles WHERE rolname = $1', ['env_live_one']), 0)
        }
        finally
        {
            await session.Dispose()
        }
    })

    it('live: killing postgres between role and database, the retry completes', { skip: ProvisionerFixture.LiveUrl === undefined || ProvisionerFixture.LiveContainer === undefined }, async () =>
    {
        const url = ProvisionerFixture.LiveUrl as string
        const container = ProvisionerFixture.LiveContainer as string
        const session = await ProvisionerFixture.Open()
        // A session that kills Postgres right after the role transaction, before the database step reaches it.
        let killed = false
        const killing = {
            Query: async (sql: string, params: readonly unknown[]) =>
            {
                if (!killed && sql.includes('pg_database'))
                {
                    killed = true
                    execFileSync('docker', ['kill', container], { stdio: 'pipe' })
                    execFileSync('docker', ['start', container], { stdio: 'pipe' })
                }
                return await session.Query(sql, params)
            },
            Execute: (sql: string, params: readonly unknown[]) => session.Execute(sql, params),
            Transaction: <T>(work: (tx: ISqlSession) => Promise<T>) => session.Transaction(work),
        } as unknown as ISqlSession
        try
        {
            // The attempt the kill breaks fails; the provisioner waits for Postgres and its retry completes the provisioning.
            const provisioner = new HivePostgresProvisioner(killing, { Wait: () => ProvisionerFixture.WaitReady(url) })
            await provisioner.Ensure('live-two', ProvisionerFixture.Password)
            assert.equal(killed, true, 'Postgres was killed between the role and the database')
            assert.equal(await ProvisionerFixture.Scalar(ProvisionerFixture.RoleUrl('live-two', ProvisionerFixture.Password), 'SELECT current_database()'), 'env_live_two')
            await provisioner.Drop('live-two')
        }
        finally
        {
            await session.Dispose().catch(() => undefined)
        }
    })
})
