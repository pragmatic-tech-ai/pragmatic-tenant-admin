import { ComponentVersionOrder } from './component-version-order.js'

/**
 * Which component versions resolve `secret:realm/<name>` at start (their directory has the realm secrets home, 2.5): the
 * first version of each that does. A target running an older version, a component not listed, or a version the console
 * does not know (a development image) keeps the interim `file` store, so a configuration it cannot read is never
 * applied to it.
 */
export class RealmCapableComponents
{
    private static readonly FirstVersions: ReadonlyMap<string, string> = new Map([
        ['pragmatic-tenant-admin', '0.1.7'],
        ['pragmatic-tenant-idp', '0.2.8'],
        ['pragmatic-env-server', '0.1.4'],
    ])

    /** Whether `component` at `version` reads the realm secrets home. */
    public static Reads(component: string, version: string | null | undefined): boolean
    {
        const first = RealmCapableComponents.FirstVersions.get(component)
        if (first === undefined || version === null || version === undefined) return false
        const order = ComponentVersionOrder.Compare(version, first)
        return order !== undefined && order >= 0
    }
}
