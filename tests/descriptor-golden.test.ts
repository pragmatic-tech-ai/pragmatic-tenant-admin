import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { Components } from '../src/release-components.js'
import { TenantAdminComponent } from '../src/tenant-admin-component.js'

/** The descriptor this repository's image carries, pinned (it moves with every change of the declaration or the package
 *  version, deliberately: the platform release binds it). */
class DescriptorGolden
{
    /** src/tests/tenant-admin-component.test.ts pins the same digest. */
    public static readonly Digest = 'sha256:4ecfc74d415ec11788b23e3fd4969734101c2436d8641c7da7fea993f428d7c8'
    private static readonly Root = join(dirname(fileURLToPath(import.meta.url)), '..')
    public static readonly PackageJson = join(DescriptorGolden.Root, 'package.json')
    public static readonly Utf8 = 'utf8'

    public static Json(path: string): Record<string, unknown>
    {
        return JSON.parse(readFileSync(path, DescriptorGolden.Utf8)) as Record<string, unknown>
    }
}

describe('descriptor golden', () =>
{
    it('the descriptor digest equals the pinned digest', () =>
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

    it('the descriptor version is the package version', () =>
    {
        assert.equal(TenantAdminComponent.Version, DescriptorGolden.Json(DescriptorGolden.PackageJson).version)
    })
})
