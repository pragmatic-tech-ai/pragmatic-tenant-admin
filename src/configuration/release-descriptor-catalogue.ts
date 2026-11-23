import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import { ComponentDescriptorSet, ReleaseApp, ReleaseDescriptorsAbsentError } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { DescriptorUnavailableError, type IComponentDescriptorSource } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

/** Reads the descriptors one signed platform release carries (ReleaseComponentDescriptors). */
export interface IReleaseDescriptorReader
{
    Descriptors(version: string): Promise<ComponentDescriptorSet>
}

/**
 * The component descriptors the tenant admin console validates configurations against, taken from the signed platform
 * release rather than a vendored copy:
 *
 * - first the mounted set of the release the console runs (`/etc/pragmatic/descriptors`, one `<app>.json` per
 *   component, mounted by the hive's chart), so a hive without registry access (Standalone, air-gapped) validates against
 *   exactly the descriptors of the containers it runs;
 * - then, for a component version that set does not hold, the adopted releases (newest first) read from the release
 *   registry, each checked against the digests its signature binds; a read that fails answers
 *   `DescriptorUnavailableError` (`descriptor-unavailable`) for that version only, never for a mounted one;
 * - and always the console's own descriptor, from its declaration.
 *
 * `Names` and `Current` are the hive components of the console's own release: those it configures.
 */
export class ReleaseDescriptorCatalogue implements IComponentDescriptorSource
{
    /** The components that run in a hive (the platform-side ones are configured by the platform, not a tenant). */
    public static readonly HiveComponents: readonly string[] = [
        ReleaseApp.EnvServer, ReleaseApp.EnvGateway, ReleaseApp.HiveAgent, ReleaseApp.TenantAdmin, ReleaseApp.TenantIdp, ReleaseApp.UiUnpack,
    ]
    public static readonly DefaultDirectory = '/etc/pragmatic/descriptors'
    private static readonly DigestsFile = 'digests.json'

    private readonly current = new Map<string, ComponentDescriptor>()
    private readonly fetched = new Map<string, ComponentDescriptorSet>()

    public constructor(
        mounted: ComponentDescriptorSet | undefined,
        own: ComponentDescriptor,
        private readonly registry: IReleaseDescriptorReader | undefined,
        private readonly releases: readonly string[],
    )
    {
        for (const name of ReleaseDescriptorCatalogue.HiveComponents)
        {
            const descriptor = mounted?.Get(name)
            if (descriptor !== undefined) this.current.set(name, descriptor)
        }
        this.current.set(own.Name, own)
    }

    /** The catalogue over the mounted directory `dir` (absent or empty: none mounted). */
    public static FromDirectory(dir: string, own: ComponentDescriptor, registry: IReleaseDescriptorReader | undefined, releases: readonly string[]): ReleaseDescriptorCatalogue
    {
        // An optional ConfigMap volume that is absent still mounts an empty directory: no digests file, no mounted set.
        const mounted = existsSync(join(dir, ReleaseDescriptorCatalogue.DigestsFile)) ? ComponentDescriptorSet.FromDirectory(dir) : undefined
        return new ReleaseDescriptorCatalogue(mounted, own, registry, releases)
    }

    public Names(): readonly string[]
    {
        return [...this.current.keys()].sort()
    }

    public Current(component: string): ComponentDescriptor | undefined
    {
        return this.current.get(component)
    }

    public async For(component: string, componentVersion: string): Promise<ComponentDescriptor | undefined>
    {
        const current = this.current.get(component)
        if (current !== undefined && current.Version === componentVersion) return current
        let unreadable: DescriptorUnavailableError | undefined
        for (const release of this.releases)
        {
            let set: ComponentDescriptorSet
            try
            {
                set = await this.ReleaseSet(component, componentVersion, release)
            }
            catch (error)
            {
                // One release out of reach must not hide a version an older adopted release carries.
                if (!(error instanceof DescriptorUnavailableError)) throw error
                unreadable = error
                continue
            }
            const descriptor = set.Get(component)
            if (descriptor !== undefined && descriptor.Version === componentVersion) return descriptor
        }
        if (unreadable !== undefined) throw unreadable
        return undefined
    }

    /** The version of `component` whose descriptor has `digest`, among the descriptors already read; undefined if none. */
    public VersionOf(component: string, digest: string): string | undefined
    {
        const known = [this.current.get(component), ...[...this.fetched.values()].map(set => set.Get(component))]
        return known.find(descriptor => descriptor !== undefined && descriptor.ContentDigest() === digest)?.Version
    }

    private async ReleaseSet(component: string, componentVersion: string, release: string): Promise<ComponentDescriptorSet>
    {
        const cached = this.fetched.get(release)
        if (cached !== undefined) return cached
        if (this.registry === undefined) throw new DescriptorUnavailableError(component, componentVersion)
        let set: ComponentDescriptorSet
        try
        {
            set = await this.registry.Descriptors(release)
        }
        catch (error)
        {
            // A release published before it carried descriptors never will: it holds none, for good.
            if (!(error instanceof ReleaseDescriptorsAbsentError)) throw new DescriptorUnavailableError(component, componentVersion)
            set = ComponentDescriptorSet.FromDescriptors([])
        }
        this.fetched.set(release, set)
        return set
    }
}
