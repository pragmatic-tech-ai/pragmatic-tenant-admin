import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DescriptorUnavailableError } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ReleaseDescriptorsAbsentError } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { TenantAdminComponent } from '../../tenant-admin-component.js'
import { ReleaseDescriptorCatalogue } from '../release-descriptor-catalogue.js'
import { ConfigurationFixture as F } from './configuration-fixture.js'

describe('ReleaseDescriptorCatalogue', () =>
{
    it('validates against the mounted descriptor of the running version without the registry', async () =>
    {
        const registry = F.Registry()
        registry.Down = true
        const catalogue = new ReleaseDescriptorCatalogue(F.Mounted(), TenantAdminComponent.Descriptor(), registry, ['0.2.0'])
        assert.equal((await catalogue.For(F.Agent, '0.1.0'))?.ContentDigest(), F.Agent010().ContentDigest())
        assert.equal(catalogue.Current(F.Agent)?.Version, '0.1.0')
        assert.equal(registry.Reads, 0, 'the registry is not asked for a mounted version')
    })

    it('fetches a newer release\'s descriptor when the mounted set lacks it', async () =>
    {
        const registry = F.Registry()
        const catalogue = new ReleaseDescriptorCatalogue(F.Mounted(), TenantAdminComponent.Descriptor(), registry, ['0.2.0', '0.1.0'])
        assert.equal((await catalogue.For(F.Agent, '0.2.0'))?.ContentDigest(), F.Agent020().ContentDigest())
        assert.equal(catalogue.VersionOf(F.Agent, F.Agent020().ContentDigest()), '0.2.0', 'a fetched descriptor is known by digest')
        await catalogue.For(F.Agent, '0.2.0')
        assert.equal(registry.Reads, 1, 'a release is read once')
        assert.equal(await catalogue.For(F.Agent, '9.9.9'), undefined)
    })

    it('registry down: descriptor-unavailable only for the unmounted version', async () =>
    {
        const registry = F.Registry()
        registry.Down = true
        const catalogue = new ReleaseDescriptorCatalogue(F.Mounted(), TenantAdminComponent.Descriptor(), registry, ['0.2.0'])
        await assert.rejects(catalogue.For(F.Agent, '0.2.0'), (error: unknown) => error instanceof DescriptorUnavailableError && DescriptorUnavailableError.Code === 'descriptor-unavailable')
        assert.ok(await catalogue.For(F.Agent, '0.1.0'))
        const keyless = new ReleaseDescriptorCatalogue(F.Mounted(), TenantAdminComponent.Descriptor(), undefined, ['0.2.0'])
        await assert.rejects(keyless.For(F.Agent, '0.2.0'), DescriptorUnavailableError)
    })

    it('an older release that carries no descriptors holds none, for good: not found, never asked again', async () =>
    {
        let reads = 0
        const reader = { Descriptors: async (version: string): Promise<never> => { reads += 1; throw new ReleaseDescriptorsAbsentError(version) } }
        const catalogue = new ReleaseDescriptorCatalogue(F.Mounted(), TenantAdminComponent.Descriptor(), reader, ['0.0.9'])
        assert.equal(await catalogue.For(F.Agent, '0.0.9'), undefined)
        assert.equal(await catalogue.For(F.Agent, '0.0.9'), undefined)
        assert.equal(reads, 1)
    })

    it('configures the hive components of the mounted set and always itself, never a platform-side one', () =>
    {
        const catalogue = new ReleaseDescriptorCatalogue(F.Mounted(), TenantAdminComponent.Descriptor(), undefined, [])
        assert.deepEqual(catalogue.Names(), [F.Server, F.Agent, 'pragmatic-tenant-admin'].sort())
        const bare = ReleaseDescriptorCatalogue.FromDirectory('/no/such/descriptors', TenantAdminComponent.Descriptor(), undefined, [])
        assert.deepEqual(bare.Names(), ['pragmatic-tenant-admin'])
        assert.equal(bare.Current('pragmatic-platform-admin'), undefined)
    })
})
