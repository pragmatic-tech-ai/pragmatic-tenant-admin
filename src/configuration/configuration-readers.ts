import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { ComponentVersionOrder } from './component-version-order.js'

/**
 * Which component versions read their applied configuration at start: the first version of each hive component whose
 * image runs the start step (`ComponentStartConfiguration`). An image from before it (the env server until its start step
 * ships, a hive agent, gateway or unpacker 0.1.0) would roll on an apply and read nothing, so the apply would be recorded
 * applied while nothing changed; the console refuses it (`component-reads-no-configuration`).
 *
 * The capability is the console's knowledge, not the descriptor's: the descriptor codec refuses unknown keys (its digest
 * covers every member), so a new descriptor member would be refused by every deployed reader of a release's descriptors.
 * A component that gains a start step adds its first version here. A version that is not known (an image whose
 * descriptor the catalogue cannot place, a development image) is taken to read it, as the unverified-target ruling says.
 */
export class ConfigurationReaders
{
    private static readonly FirstReading: ReadonlyMap<string, string> = new Map<string, string>([
        // 0.1.1 is the first env server on Postgres (A5.4); its start step ships in 0.1.2 (the C3.1 env-server row).
        [ReleaseApp.EnvServer, '0.1.2'],
        [ReleaseApp.HiveAgent, '0.1.1'],
        [ReleaseApp.EnvGateway, '0.1.1'],
        [ReleaseApp.UiUnpack, '0.1.1'],
        [ReleaseApp.TenantIdp, '0.2.1'],
        [ReleaseApp.TenantAdmin, '0.1.1'],
    ])

    private constructor()
    {
    }

    /** Whether `component` at `version` reads its configuration at start (true when the version is not known). */
    public static Reads(component: string, version: string | undefined): boolean
    {
        if (version === undefined) return true
        const first = ConfigurationReaders.FirstReading.get(component)
        if (first === undefined) return false
        const compared = ComponentVersionOrder.Compare(version, first)
        return compared === undefined || compared >= 0
    }
}
