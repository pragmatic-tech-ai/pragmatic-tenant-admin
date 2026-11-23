import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppliedConfiguration, ComponentStartConfiguration, SettingValueEncoding, type IStartProcess } from '@pragmatic-tech-ai/pragmatic-configuration'
import { SettingType } from '@pragmatic-tech-ai/pragmatic-component'
import { ConsoleConfiguration } from '../configuration/console-configuration.js'
import { TenantAdminComponent } from '../tenant-admin-component.js'
import { TenantAdminServer } from '../tenant-admin-server.js'

class StartWorld
{
    public static Env(path: string): NodeJS.ProcessEnv
    {
        return {
            PRAGMATIC_CONFIGURATION_FILE: path,
            PRAGMATIC_TENANT_ADMIN_DATA_ROOT: '/data',
            PRAGMATIC_TENANT_ADMIN_PORT: '7100',
            PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN: 'env.test',
        }
    }

    public static async InFolder(body: (folder: string) => Promise<void>): Promise<void>
    {
        const folder = await mkdtemp(join(tmpdir(), 'tenant-admin-start-'))
        try
        {
            await body(folder)
        }
        finally
        {
            await rm(folder, { recursive: true, force: true })
        }
    }

    public static async Configuration(folder: string, core: Record<string, unknown>): Promise<string>
    {
        const descriptor = TenantAdminComponent.Descriptor()
        const applied = new AppliedConfiguration('acme', descriptor.Name, 3, descriptor.Version, descriptor.ContentDigest(), { options: { core } } as never)
        const path = join(folder, 'configuration.json')
        await writeFile(path, applied.ToCanonicalJson())
        return path
    }
}

class ExitRecorder implements IStartProcess
{
    public Code: number | undefined
    public Text = ''
    public readonly stderr = { write: (text: string): boolean => { this.Text += text; return true } }

    public exit(code: number): never
    {
        this.Code = code
        throw new Error('exit')
    }
}

describe('the console reads its configuration at start', () =>
{
    const Core = { dataRoot: '/configured', databaseUrl: 'secret:file/db-url', port: 7443, baseDomain: 'configured.test', secureCookie: true }

    it('a mounted configuration overrides the declared variable before the settings are read', async () =>
    {
        await StartWorld.InFolder(async folder =>
        {
            const env = StartWorld.Env(await StartWorld.Configuration(folder, Core))
            await writeFile(join(folder, 'db-url'), 'postgres://x')
            await ComponentStartConfiguration.Apply({ Declaration: TenantAdminComponent.Declaration, Env: env, Stores: ComponentStartConfiguration.Stores('', folder), SecretsDir: join(folder, 'run') })
            const config = TenantAdminServer.ReadConfig(env)
            assert.deepEqual([config.dataRoot, config.port, config.baseDomain, config.secureCookie], ['/configured', 7443, 'configured.test', true])
            assert.equal(env.PRAGMATIC_TENANT_ADMIN_DATABASE_URL_FILE, join(folder, 'run', 'core.databaseUrl'))
        })
    })

    it('no configuration starts as before', async () =>
    {
        const env = StartWorld.Env('/no/such/configuration.json')
        const report = await ComponentStartConfiguration.ApplyOrExit({ Declaration: TenantAdminComponent.Declaration, Env: env })
        assert.equal(report.Applied, false)
        assert.equal(TenantAdminServer.ReadConfig(env).port, 7100)
    })

    it('an invalid configuration exits with the start error code 78 and the reason', async () =>
    {
        await StartWorld.InFolder(async folder =>
        {
            const process = new ExitRecorder()
            const env = StartWorld.Env(await StartWorld.Configuration(folder, { port: 'not-a-port' }))
            await assert.rejects(ComponentStartConfiguration.ApplyOrExit({ Declaration: TenantAdminComponent.Declaration, Env: env }, process))
            assert.equal(process.Code, 78)
            assert.match(process.Text, /pragmatic-tenant-admin: .*\(invalid\)/)
        })
    })

    it('every list setting reads the JSON array encoding', () =>
    {
        const releases = ['0.2.0', '0.1.0-early.6']
        assert.deepEqual(ConsoleConfiguration.ReleasesOf({ PRAGMATIC_TENANT_ADMIN_RELEASES: SettingValueEncoding.Encode(SettingType.List, releases) }), releases)
        assert.deepEqual(ConsoleConfiguration.ReleasesOf({ PRAGMATIC_TENANT_ADMIN_RELEASES: '0.2.0, 0.1.0-early.6' }), releases, 'the hand-written comma form stays')
        const lists = TenantAdminComponent.Descriptor().Options.flatMap(o => o.Settings).filter(s => s.Type === SettingType.List).map(s => s.Name)
        assert.deepEqual(lists, [], 'the console declares no list setting; its one list variable (releases) is platform-owned')
    })

    it('platform-owned settings are not configurable: the rollout link, the injected IdP and the release trust roots', () =>
    {
        const names = TenantAdminComponent.Descriptor().Options.flatMap(o => o.Settings.map(s => `${o.Name}.${s.Name}`))
        for (const owned of ['rollout.url', 'rollout.token', 'idp.adminToken', 'core.releaseKeysDir', 'core.releaseRegistry', 'core.descriptorsDir'])
        {
            assert.ok(!names.includes(owned), owned)
        }
    })

    it('the rollout token is read from its _FILE, where the start step writes a configured secret', async () =>
    {
        await StartWorld.InFolder(async folder =>
        {
            await writeFile(join(folder, 'token'), 'file-token')
            const client = TenantAdminServer.RolloutClientFrom({ PRAGMATIC_TENANT_ADMIN_ROLLOUT_URL: 'https://channel.test', PRAGMATIC_TENANT_ADMIN_ROLLOUT_TOKEN_FILE: join(folder, 'token'), PRAGMATIC_TENANT_ADMIN_ROLLOUT_HIVE_ID: 'h1' })
            assert.ok(JSON.stringify(Object.keys(client)).length > 0)
            assert.throws(() => TenantAdminServer.RolloutClientFrom({ PRAGMATIC_TENANT_ADMIN_ROLLOUT_URL: 'https://channel.test', PRAGMATIC_TENANT_ADMIN_ROLLOUT_HIVE_ID: 'h1' }), /PRAGMATIC_TENANT_ADMIN_ROLLOUT_TOKEN/)
        })
    })
})
