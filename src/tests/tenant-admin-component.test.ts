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
    public static readonly Digest = 'sha256:8c5529358bf3d4e70167c7638ba991172280f8593a9886d507eb4e0ed34ec3ff'
    public static readonly Readers = [
        ComponentSources.InPackage('@pragmatic-tech-ai/pragmatic-tenant-plane', 'tenant-admin-env.js'),
        join(TenantAdminComponentFixture.Here, '..', 'configuration', 'console-configuration.ts'),
    ]
    /** Platform-owned: injected by the hive manifests, never tenant-configurable (the descriptor leaves them out), by reason. */
    public static readonly PlatformOwned: Readonly<Record<string, readonly string[]>> = {
        'the rollout link to the platform and its token': ['PRAGMATIC_TENANT_ADMIN_ROLLOUT_URL', 'PRAGMATIC_TENANT_ADMIN_ROLLOUT_TOKEN', 'PRAGMATIC_TENANT_ADMIN_ROLLOUT_HIVE_ID'],
        'the injected IdP and its trust': ['PRAGMATIC_IDP_BROWSER_BASE_URL', 'PRAGMATIC_IDP_BASE_URL', 'PRAGMATIC_IDP_CA_FILE', 'PRAGMATIC_IDP_ADMIN_TOKEN_FILE'],
        'the release descriptors and their trust roots': ['PRAGMATIC_TENANT_ADMIN_DESCRIPTORS_DIR', 'PRAGMATIC_TENANT_ADMIN_RELEASES', 'PRAGMATIC_TENANT_ADMIN_RELEASE_KEYS_DIR', 'PRAGMATIC_TENANT_ADMIN_RELEASE_REGISTRY'],
        'its own Deployment, state folder and database': ['PRAGMATIC_TENANT_ADMIN_DEPLOYMENT', 'PRAGMATIC_TENANT_ADMIN_DATA_ROOT', 'PRAGMATIC_TENANT_ADMIN_DATABASE_URL_FILE'],
        // The Deployment's containerPort and readiness probe, its Service and its Ingress are rendered against these: a console
        // that changed one would start, fail its probe and leave the tenant without the console it would repair it from.
        'its listener, host and origins (the wiring its probe, Service and Ingress are rendered against)': [
            'PRAGMATIC_TENANT_ADMIN_PORT', 'PRAGMATIC_TENANT_ADMIN_BIND', 'PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN', 'PRAGMATIC_TENANT_ADMIN_CONSOLE_HOST',
            'PRAGMATIC_TENANT_ADMIN_EXTERNAL_SCHEME', 'PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT', 'PRAGMATIC_TENANT_ADMIN_TRUSTED_PROXY', 'PRAGMATIC_TENANT_ADMIN_PORTAL_DIR',
        ],
        // Rendered from the external scheme: Secure on plain http drops every session (nobody could sign in to undo it).
        'the Secure cookie flag (derived from the external scheme)': ['PRAGMATIC_TENANT_ADMIN_SECURE_COOKIE'],
        'the fingerprint key the platform shares with it (the advert)': ['PRAGMATIC_TENANT_ADMIN_FINGERPRINT_KEY_FILE'],
        'the Ingress TLS choice of the hive console spec (one for the console, its IdP and its environments)': [
            'PRAGMATIC_TENANT_ADMIN_INGRESS_TLS_SOURCE', 'PRAGMATIC_TENANT_ADMIN_INGRESS_TLS_SECRET', 'PRAGMATIC_TENANT_ADMIN_INGRESS_TLS_ISSUER',
        ],
    }
    public static readonly Undeclared: readonly string[] = Object.values(TenantAdminComponentFixture.PlatformOwned).flat()
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

    it('requires no setting and holds no secret: the deployment injects the rest, so a configuration names one only to change it', () =>
    {
        const settings = TenantAdminComponent.Descriptor().Options.flatMap(o => o.Settings)
        assert.deepEqual(settings.filter(s => s.Required).map(s => s.Name), [])
        assert.deepEqual(settings.filter(s => s.Secret).map(s => s.Name), [], 'the database URL and the fingerprint key are platform-owned, not tenant secret settings')
    })

    it('declares only what a tenant may tune: none of its own wiring (listener, host, origins, proxy, portal, TLS), so it cannot lock itself out', () =>
    {
        const descriptor = TenantAdminComponent.Descriptor()
        assert.deepEqual(descriptor.Options.map(o => o.Name), ['core'])
        assert.deepEqual(descriptor.Options[0].Settings.map(s => s.Name), ['secretTtlHours', 'healthProbeMs', 'healthProbeTimeoutMs', 'desktopRealmSignIn'])
        const declared = ComponentSources.Declared(descriptor)
        for (const [reason, variables] of Object.entries(TenantAdminComponentFixture.PlatformOwned))
        {
            assert.deepEqual(variables.filter(v => declared.includes(v)), [], reason)
        }
    })

    it('is named for its release image', () =>
    {
        assert.equal(TenantAdminComponent.Descriptor().Name, 'pragmatic-tenant-admin')
    })
})
