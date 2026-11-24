import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { TenantRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { InitialOwnerSeeder, type IOwnerRealm, type ISeedWait } from '../initial-owner-seeder.js'

class FlakyRealm implements IOwnerRealm
{
    public readonly Realms: Array<[string, string]> = []
    public readonly Accounts: Array<{ tenantId: string; email: string; principalId: string; password: string }> = []

    public constructor(private failures: number)
    {
    }

    public async EnsureRealm(tenantId: string, displayName: string): Promise<void>
    {
        if (this.failures > 0)
        {
            this.failures--
            throw new TypeError('fetch failed')
        }
        this.Realms.push([tenantId, displayName])
    }

    public async SeedAccount(tenantId: string, account: { email: string; principalId: string; displayName: string; password: string }): Promise<void>
    {
        this.Accounts.push({ tenantId, email: account.email, principalId: account.principalId, password: account.password })
    }
}

class CountingWait implements ISeedWait
{
    public Waits = 0

    public async Wait(): Promise<void>
    {
        this.Waits++
    }
}

class SeederFixture
{
    public static readonly Tenant: TenantRecord = { id: 'acme', clientId: 'acme', displayName: 'Acme', createdAt: '2026-11-24T00:00:00Z', ownerEmail: 'owner@acme.example' }
    public static readonly Password = 'one-time-password-value'

    public static async InTemp(body: (dir: string) => Promise<void>): Promise<void>
    {
        const dir = mkdtempSync(join(tmpdir(), 'owner-seed-'))
        try
        {
            await body(dir)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }
}

describe('InitialOwnerSeeder', () =>
{
    it('retries until the sign-in service answers, then seeds the realm and the Owner with the one-time password', async () =>
    {
        await SeederFixture.InTemp(async dir =>
        {
            writeFileSync(join(dir, 'email'), 'owner@acme.example\n')
            writeFileSync(join(dir, 'password'), SeederFixture.Password)
            const realm = new FlakyRealm(2)
            const wait = new CountingWait()
            const lines: string[] = []
            await new InitialOwnerSeeder(SeederFixture.Tenant, dir, async () => realm, line => lines.push(line), wait).Run()
            assert.equal(wait.Waits, 2)
            assert.deepEqual(realm.Realms, [['acme', 'Acme']])
            assert.deepEqual(realm.Accounts, [{ tenantId: 'acme', email: 'owner@acme.example', principalId: 'owner', password: SeederFixture.Password }])
            assert.ok(lines.every(line => !line.includes(SeederFixture.Password) && !line.includes('owner@acme.example')))
            assert.match(lines.at(-1) ?? '', /seeded/)
        })
    })

    it('seeds nothing when the one-time sign-in is unreadable', async () =>
    {
        await SeederFixture.InTemp(async dir =>
        {
            const realm = new FlakyRealm(0)
            const lines: string[] = []
            await new InitialOwnerSeeder(SeederFixture.Tenant, dir, async () => realm, line => lines.push(line), new CountingWait()).Run()
            assert.deepEqual(realm.Realms, [])
            assert.match(lines[0], /unreadable/)
        })
    })
})
