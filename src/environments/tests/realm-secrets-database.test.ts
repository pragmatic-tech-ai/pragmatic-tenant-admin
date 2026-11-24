import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl'
import { CustomRealmSecrets, PgSession } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { PostgresPoolFactory } from '@pragmatic-tech-ai/pragmatic-realm-custom'
import { MountedRealmSecretsMaterial, RealmSecretsDatabase, RealmSecretsDatabaseError } from '../realm-secrets-database.js'
import type { IProvisionWait } from '../hive-postgres-provisioner.js'
import { TenantAdminServer } from '../../tenant-admin-server.js'

class NoWait implements IProvisionWait
{
    public Waits = 0

    public async Wait(): Promise<void>
    {
        this.Waits++
    }
}

/** Records the superuser's statements; `failures` makes the first statements throw (Postgres still starting). */
class RecordingSession
{
    public readonly Statements: Array<{ sql: string; params: readonly unknown[] }> = []
    public Exists = false

    public constructor(private failures: number = 0)
    {
    }

    public async Query(sql: string, params: readonly unknown[]): Promise<readonly SqlRow[]>
    {
        this.Fail()
        this.Statements.push({ sql, params })
        if (sql.includes('current_schema()')) return [{ schema: 'public', database: 'realm_secrets' }]
        return sql.includes('pg_database') && this.Exists ? [{ owner: 'postgres' }] : []
    }

    public async Execute(sql: string, params: readonly unknown[]): Promise<number>
    {
        this.Fail()
        this.Statements.push({ sql, params })
        if (sql.startsWith('CREATE DATABASE')) this.Exists = true
        return 0
    }

    public async Transaction<T>(work: (tx: ISqlSession) => Promise<T>): Promise<T>
    {
        return await work(this as unknown as ISqlSession)
    }

    private Fail(): void
    {
        if (this.failures > 0)
        {
            this.failures--
            throw new Error('the database system is starting up')
        }
    }
}

class RealmFixture
{
    public static readonly Roles = [
        { Role: 'realm_secrets_console', Password: 'console-password-never-logged' },
        { Role: 'realm_secrets_idp', Password: 'idp-password-never-logged' },
        { Role: 'realm_secrets_environments', Password: 'environments-password-never-logged' },
    ]
    /** A test Postgres superuser URL: a disposable pragmatic-postgres, or the hive laptop's test container (its user variable). */
    public static readonly LiveUrl = process.env.PRAGMATIC_TEST_HIVE_PG_SUPERUSER_URL ?? process.env.PRAGMATIC_TEST_PG_ADMIN_URL

    public static Folder(files: Record<string, string>): string
    {
        const dir = mkdtempSync(join(tmpdir(), 'realm-secrets-'))
        for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
        return dir
    }

    public static async Open(url: string, database?: string): Promise<PgSession>
    {
        const dir = RealmFixture.Folder({ 'database-url': url })
        try
        {
            return new PgSession(await new PostgresPoolFactory({ UrlFile: join(dir, 'database-url'), MaxConnections: 1, Database: database }).Create())
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }

    public static RoleUrl(role: string, password: string): string
    {
        const url = new URL(RealmFixture.LiveUrl as string)
        url.username = role
        url.password = password
        url.pathname = '/realm_secrets'
        return url.toString()
    }
}

describe('RealmSecretsDatabase', () =>
{
    it('the console provisions the home before its configuration (and so its directory) opens it', async () =>
    {
        const steps: string[] = []
        const config = await TenantAdminServer.StartConfig({}, async () => { steps.push('provision') }, async () =>
        {
            steps.push('configuration')
            return 'read'
        })
        assert.equal(config, 'read')
        assert.deepEqual(steps, ['provision', 'configuration'])
        const refused: string[] = []
        await assert.rejects(TenantAdminServer.StartConfig({}, async () => { throw new RealmSecretsDatabaseError('57P03') }, async () => { refused.push('configuration') }), RealmSecretsDatabaseError)
        assert.deepEqual(refused, [], 'a home that cannot be provisioned stops the start before anything opens it')
    })

    it('applies only to the chart\'s custom option (the roles folder mounted)', () =>
    {
        assert.equal(RealmSecretsDatabase.Applies({ PRAGMATIC_REALM_SECRETS_OPTION: 'custom', PRAGMATIC_TENANT_ADMIN_REALM_SECRETS_ROLES_DIR: '/run/secrets/realm-secrets-roles' }), true)
        assert.equal(RealmSecretsDatabase.Applies({ PRAGMATIC_REALM_SECRETS_OPTION: 'gcp', PRAGMATIC_TENANT_ADMIN_REALM_SECRETS_ROLES_DIR: '/x' }), false)
        assert.equal(RealmSecretsDatabase.Applies({ PRAGMATIC_REALM_SECRETS_OPTION: 'custom' }), false, 'a pushed console provisions nothing')
        assert.equal(RealmSecretsDatabase.Applies({}), false)
    })

    it('a start without the custom option touches nothing', async () =>
    {
        await RealmSecretsDatabase.EnsureFromEnvironment({ PRAGMATIC_REALM_SECRETS_OPTION: 'gcp' }, () => assert.fail('nothing to log'))
    })

    it('reads the three roles from the mounted folder and refuses an empty password', async () =>
    {
        const dir = RealmFixture.Folder({ console: 'c\n', idp: 'i', environments: 'e\r\n' })
        try
        {
            assert.deepEqual(await RealmSecretsDatabase.ReadRoles(dir), [
                { Role: 'realm_secrets_console', Password: 'c' }, { Role: 'realm_secrets_idp', Password: 'i' }, { Role: 'realm_secrets_environments', Password: 'e' },
            ])
            writeFileSync(join(dir, 'idp'), '\n')
            await assert.rejects(RealmSecretsDatabase.ReadRoles(dir), /empty: idp/)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('the console and the sign-in service write, the environments read', () =>
    {
        const grant = RealmSecretsDatabase.GrantOf('acme')
        assert.deepEqual(grant.Writers, ['realm_secrets_console', 'realm_secrets_idp'])
        assert.deepEqual(grant.Readers, ['realm_secrets_environments'])
    })

    it('creates the roles (as verifiers), the database once, and provisions the home in it; never a password in a statement', async () =>
    {
        const superuser = new RecordingSession()
        const opened: string[] = []
        const sessions: RecordingSession[] = []
        const open = async () =>
        {
            opened.push('realm_secrets')
            const session = new RecordingSession()
            sessions.push(session)
            return session as unknown as ISqlSession
        }
        const database = new RealmSecretsDatabase(superuser as unknown as ISqlSession, new NoWait())
        await database.Ensure(RealmFixture.Roles, 'acme', open)
        await database.Ensure(RealmFixture.Roles, 'acme', open)
        assert.equal(superuser.Statements.filter(s => s.sql === 'CREATE DATABASE "realm_secrets"').length, 1)
        assert.equal(superuser.Statements.filter(s => s.sql.includes('ALTER ROLE')).length, 6, 'each role on each start')
        const text = JSON.stringify(superuser.Statements)
        for (const role of RealmFixture.Roles) assert.equal(text.includes(role.Password), false, role.Role)
        assert.ok(superuser.Statements.some(s => s.params.some(p => typeof p === 'string' && p.startsWith('SCRAM-SHA-256$4096:'))))
        assert.deepEqual(opened, ['realm_secrets', 'realm_secrets'])
        assert.equal(superuser.Statements.some(s => s.sql === 'REVOKE ALL ON DATABASE "realm_secrets" FROM PUBLIC'), true)
        assert.equal(sessions[0]!.Statements[0]!.sql, 'REVOKE CREATE ON SCHEMA public FROM PUBLIC', 'in the home, before its schema is made')
    })

    it('a Postgres still starting is retried', async () =>
    {
        const wait = new NoWait()
        const superuser = new RecordingSession(2)
        await new RealmSecretsDatabase(superuser as unknown as ISqlSession, wait).Ensure(RealmFixture.Roles, 'acme', async () => new RecordingSession() as unknown as ISqlSession)
        assert.equal(wait.Waits, 2)
        assert.equal(superuser.Exists, true)
        const never = new RecordingSession(99)
        await assert.rejects(new RealmSecretsDatabase(never as unknown as ISqlSession, new NoWait()).Ensure(RealmFixture.Roles, 'acme', async () => new RecordingSession() as unknown as ISqlSession),
            (error: Error) => error instanceof RealmSecretsDatabaseError && /SQLSTATE none/.test(error.message) && !error.message.includes('starting up'), 'typed, never the driver text')
        assert.equal(RealmSecretsDatabaseError.Of(Object.assign(new Error('permission denied for role realm_secrets_idp'), { code: '42501' })).message, 'the custom realm secrets home could not be provisioned on the hive Postgres (SQLSTATE 42501)')
    })

    it('the environments\' material is the reader URL file and the realm master key file', async () =>
    {
        const dir = RealmFixture.Folder({ 'database-url': 'postgres://realm_secrets_environments:p@h:5432/realm_secrets', 'master.key': 'k'.repeat(32) })
        try
        {
            assert.equal(MountedRealmSecretsMaterial.FromEnvironment({ PRAGMATIC_REALM_SECRETS_MASTER_KEY_FILE: join(dir, 'master.key') }), undefined, 'no reader URL: a cloud option')
            const material = MountedRealmSecretsMaterial.FromEnvironment({
                PRAGMATIC_TENANT_ADMIN_REALM_SECRETS_READER_URL_FILE: join(dir, 'database-url'), PRAGMATIC_REALM_SECRETS_MASTER_KEY_FILE: join(dir, 'master.key'),
            })!
            const read = await material.Read()
            assert.match(read.DatabaseUrl.toString(), /realm_secrets_environments/)
            assert.equal(read.MasterKey.length, 32)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('live: the console writes, the sign-in service writes, the environments only read, and nobody sees another realm', { skip: RealmFixture.LiveUrl === undefined }, async () =>
    {
        const url = RealmFixture.LiveUrl as string
        const superuser = await RealmFixture.Open(url)
        try
        {
            const database = new RealmSecretsDatabase(superuser)
            const open = () => RealmFixture.Open(url, 'realm_secrets')
            await database.Ensure(RealmFixture.Roles, 'acme', open)
            await database.Ensure(RealmFixture.Roles, 'acme', open)
            const key = Buffer.alloc(32, 9)
            const writerSession = await RealmFixture.Open(RealmFixture.RoleUrl('realm_secrets_console', RealmFixture.Roles[0]!.Password))
            const readerSession = await RealmFixture.Open(RealmFixture.RoleUrl('realm_secrets_environments', RealmFixture.Roles[2]!.Password))
            const owner = await RealmFixture.Open(url, 'realm_secrets')
            try
            {
                await CustomRealmSecrets.Over(writerSession, key, 'acme', true).Put('probe', 'probe-value')
                assert.equal(await CustomRealmSecrets.Over(readerSession, key, 'acme', false).Get('probe'), 'probe-value')
                // The reader role cannot write even when its store claims to: Postgres refuses it.
                await assert.rejects(CustomRealmSecrets.Over(readerSession, key, 'acme', true).Put('probe', 'changed'))
                // Another realm's row (written by the owner) is invisible to this realm's roles.
                await CustomRealmSecrets.Over(owner, key, 'globex', true).Put('probe', 'globex-value')
                assert.equal(await CustomRealmSecrets.Over(readerSession, key, 'globex', false).Get('probe'), null)
                assert.equal(await CustomRealmSecrets.Over(readerSession, key, 'acme', false).Get('probe'), 'probe-value')
            }
            finally
            {
                await writerSession.Dispose()
                await readerSession.Dispose()
                await owner.Dispose()
            }
        }
        finally
        {
            // The test server is shared: the home and its roles go again.
            await superuser.Execute('DROP DATABASE IF EXISTS "realm_secrets" WITH (FORCE)', [])
            for (const role of RealmFixture.Roles) await superuser.Execute('DROP ROLE IF EXISTS "' + role.Role + '"', [])
            await superuser.Dispose()
        }
    })
})
