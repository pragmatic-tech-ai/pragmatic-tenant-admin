import { TenantAdminComponent } from '../tenant-admin-component.js'
import { ComponentVersionOrder } from './component-version-order.js'

/**
 * Which component versions resolve `secret:realm/<name>` at start (their directory has the realm secrets home, 2.5): the
 * first version of each that does, where the hive also gives it the home's settings. A target running an older version,
 * a component not listed, or a version the console does not know (a development image) keeps the interim `file` store,
 * so a configuration it cannot read is never applied to it.
 *
 * The engine chart gives the home's settings to the engine components (the console, the realm sign-in service); the console
 * renders the same settings, and a projected token or the custom home's reader mounts, into every environment's server
 * (EnvironmentRealmSecrets), which reads the home from 0.1.4.
 */
export class RealmCapableComponents
{
    private static readonly IdpName = 'pragmatic-tenant-idp'
    private static readonly IdpFirst = '0.2.8'
    private static readonly ConsoleFirst = '0.1.9'
    private static readonly EnvServerName = 'pragmatic-env-server'
    private static readonly EnvServerFirst = '0.1.4'

    /** The engine components the chart gives the realm secrets home. */
    public static readonly Default = new RealmCapableComponents(new Map([
        [TenantAdminComponent.Name, RealmCapableComponents.ConsoleFirst],
        [RealmCapableComponents.IdpName, RealmCapableComponents.IdpFirst],
        [RealmCapableComponents.EnvServerName, RealmCapableComponents.EnvServerFirst],
    ]))

    public constructor(private readonly firstVersions: ReadonlyMap<string, string>)
    {
    }

    /** Whether `component` at `version` reads the realm secrets home. */
    public Reads(component: string, version: string | null | undefined): boolean
    {
        const first = this.firstVersions.get(component)
        if (first === undefined || version === null || version === undefined) return false
        const order = ComponentVersionOrder.Compare(version, first)
        return order !== undefined && order >= 0
    }
}
