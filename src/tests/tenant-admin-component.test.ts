import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TenantAdminComponent } from '../tenant-admin-component.js'
import { ComponentGolden } from './component-golden.js'
import { ComponentSources } from './component-sources.js'

class TenantAdminComponentFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly Golden = join(TenantAdminComponentFixture.Here, 'fixtures', 'pragmatic-tenant-admin.component.json')
    public static readonly Digest = 'sha256:be78ef99fb6459499326791c323479344ff0ef6eb897f81d65ef843ba43fb9bf'
    public static readonly Readers = [
        ComponentSources.InPackage('@pragmatic-tech-ai/pragmatic-tenant-plane', 'tenant-admin-env.js'),
        join(TenantAdminComponentFixture.Here, '..', 'configuration', 'console-configuration.ts'),
    ]
    /** Platform-owned: injected by the hive manifests, never tenant-configurable (the descriptor leaves them out). */
    public static readonly Undeclared: readonly string[] = [
        'PRAGMATIC_TENANT_ADMIN_ROLLOUT_URL', 'PRAGMATIC_TENANT_ADMIN_ROLLOUT_TOKEN', 'PRAGMATIC_TENANT_ADMIN_ROLLOUT_HIVE_ID',
        'PRAGMATIC_IDP_BROWSER_BASE_URL', 'PRAGMATIC_IDP_BASE_URL', 'PRAGMATIC_IDP_CA_FILE', 'PRAGMATIC_IDP_ADMIN_TOKEN_FILE',
        'PRAGMATIC_TENANT_ADMIN_DESCRIPTORS_DIR', 'PRAGMATIC_TENANT_ADMIN_RELEASES', 'PRAGMATIC_TENANT_ADMIN_RELEASE_KEYS_DIR', 'PRAGMATIC_TENANT_ADMIN_RELEASE_REGISTRY',
        'PRAGMATIC_TENANT_ADMIN_DEPLOYMENT', 'PRAGMATIC_TENANT_ADMIN_DATA_ROOT', 'PRAGMATIC_TENANT_ADMIN_DATABASE_URL_FILE',
    ]
}

describe('TenantAdminComponent', () =>
{
    it('pins the descriptor: golden JSON and content digest', () =>
    {
        ComponentGolden.Check(TenantAdminComponent.Descriptor(), TenantAdminComponentFixture.Golden, TenantAdminComponentFixture.Digest)
    })

    it('declares exactly the variables its configuration readers read', () =>
    {
        ComponentSources.AssertCovers(TenantAdminComponent.Descriptor(), TenantAdminComponentFixture.Readers, TenantAdminComponentFixture.Undeclared)
    })

    it('requires no core setting: the deployment injects them, so a configuration names one only to change it', () =>
    {
        const core = TenantAdminComponent.Descriptor().Options.find(o => o.Name === 'core')!
        assert.deepEqual(core.Settings.filter(s => s.Required).map(s => s.Name), [])
        assert.deepEqual(core.Settings.filter(s => s.Secret).map(s => s.Name), ['fingerprintKey'], 'the database URL is injected by the platform, not a tenant secret setting')
    })

    it('is named for its release image', () =>
    {
        assert.equal(TenantAdminComponent.Descriptor().Name, 'pragmatic-tenant-admin')
    })
})
