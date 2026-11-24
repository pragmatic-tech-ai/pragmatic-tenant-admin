import { SettingType, type ComponentDescriptor, ComponentDeclarations, type ComponentDeclaration } from '@pragmatic-tech-ai/pragmatic-component'
import { TenantRoles } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

/**
 * The component descriptor of the tenant admin image (pragmatic-tenant-admind, the console that ships into a client hive):
 * the `TenantAdminEnv` contract as `TenantAdminServer` reads it. Stores in Postgres (A5). Declares its application role
 * (`environment-admin`; the tenant role `admin` is the realm's own).
 *
 * Only what a tenant may tune is declared. Everything that binds the console to the platform, to its trust roots, to its
 * own Deployment or to its storage is the platform's, injected by the hive manifests and left out of the descriptor, so no
 * tenant configuration can set it (C3.1 Ledger, platform-owned settings): the rollout link and its token, the injected
 * IdP, the release descriptors, keys and registry, the state folder and the database URL; and the console's own wiring,
 * which its Deployment, Service, Ingress and readiness probe are rendered against (listener port and address, base
 * domain, console host, external scheme and port, proxy trust, the portal folder, and the Secure cookie flag derived from
 * the external scheme: Secure on plain http drops every session, off on https is a downgrade), the fingerprint key the platform
 * shares with it, and the Ingress TLS choice of the hive's console spec. A console that applied any of these to itself
 * could start, fail its probe and leave the tenant with no console to repair it from.
 */
export class TenantAdminComponent
{
    public static readonly Name = 'pragmatic-tenant-admin'
    /** The descriptor version: this application's package version (the release test pins it to package.json). */
    public static readonly Version = '0.1.5'

    /** The declaration: the descriptor, and the variable the start step overlays each configured setting onto. */
    public static readonly Declaration: ComponentDeclaration = {
        name: TenantAdminComponent.Name,
        version: TenantAdminComponent.Version,
        options: [
            {
                name: 'core',
                description: 'The tenant console: issued secrets, environment health probes and desktop sign-in.',
                settings: [
                    { name: 'secretTtlHours', type: SettingType.Integer, source: 'PRAGMATIC_TENANT_ADMIN_SECRET_TTL_HOURS', default: 168, description: 'Lifetime of issued tenant secrets, in hours.' },
                    { name: 'healthProbeMs', type: SettingType.Integer, source: 'PRAGMATIC_TENANT_ADMIN_HEALTH_PROBE_MS', default: 30000, description: 'Interval of environment health probes, in milliseconds.' },
                    { name: 'healthProbeTimeoutMs', type: SettingType.Integer, source: 'PRAGMATIC_TENANT_ADMIN_HEALTH_PROBE_TIMEOUT_MS', default: 60000, description: 'Timeout of one environment health probe, in milliseconds.' },
                    { name: 'desktopRealmSignIn', type: SettingType.Boolean, source: 'PRAGMATIC_TENANT_ADMIN_DESKTOP_REALM_SIGN_IN', description: 'Whether desktop apps sign in through the realm (unset keeps the default of the console: on when the realm sign-in service is co-hosted).' },
                ],
            },
        ],
        roles: [
            { name: TenantRoles.EnvironmentAdmin, description: 'A tenant member who manages the tenant environments and their rollout (not access or settings).' },
        ],
        postgres: true,
        ports: [{ name: 'http', number: 7100 }],
        health: { port: 'http', path: '/healthz' },
    }

    public static Descriptor(): ComponentDescriptor
    {
        return ComponentDeclarations.Build(TenantAdminComponent.Declaration)
    }
}
