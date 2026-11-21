import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ComponentDescriptorSet, ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { Components } from '../src/release-components.js'
import { TenantAdminComponent } from '../src/tenant-admin-component.js'

/** The descriptor this repository's image carries, pinned to pragmatic-server's (2a2e8138) golden digest. */
class DescriptorGolden
{
    /** pragmatic-server admin/control-plane/tests/tenant-admin-component.test.ts and descriptors/digests.json. */
    public static readonly Digest = 'sha256:98bddb2de6fe2fe034b21e75550028708eac6e4d98b63fcd10d633e47c699577'
    private static readonly Root = join(dirname(fileURLToPath(import.meta.url)), '..')
    public static readonly VendoredDirectory = join(DescriptorGolden.Root, 'src', 'descriptors')
    public static readonly VendoredDigests = join(DescriptorGolden.VendoredDirectory, 'digests.json')
    public static readonly PackageJson = join(DescriptorGolden.Root, 'package.json')
    public static readonly Utf8 = 'utf8'

    public static Json(path: string): Record<string, unknown>
    {
        return JSON.parse(readFileSync(path, DescriptorGolden.Utf8)) as Record<string, unknown>
    }
}

describe('descriptor golden', () =>
{
    it('the descriptor digest equals the pinned pragmatic-server digest', () =>
    {
        assert.equal(TenantAdminComponent.Descriptor().ContentDigest(), DescriptorGolden.Digest)
    })

    it('the release module serves exactly that descriptor for pragmatic-tenant-admin', () =>
    {
        const all = Components.All()
        assert.equal(all.length, 1)
        assert.equal(all[0][0], ReleaseApp.TenantAdmin)
        assert.equal(all[0][1].ContentDigest(), DescriptorGolden.Digest)
    })

    it('the vendored descriptor set pins the same digest for this console', () =>
    {
        assert.equal(DescriptorGolden.Json(DescriptorGolden.VendoredDigests)[ReleaseApp.TenantAdmin], DescriptorGolden.Digest)
    })

    it('the vendored descriptor file of this console has exactly that digest', () =>
    {
        const vendored = ComponentDescriptorSet.FromDirectory(DescriptorGolden.VendoredDirectory).Get(ReleaseApp.TenantAdmin)
        assert.equal(vendored?.ContentDigest(), DescriptorGolden.Digest)
    })

    it('the descriptor version is the package version', () =>
    {
        assert.equal(TenantAdminComponent.Version, DescriptorGolden.Json(DescriptorGolden.PackageJson).version)
    })
})
