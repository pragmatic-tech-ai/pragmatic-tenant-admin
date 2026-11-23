import { SettingType, type ComponentDescriptor, ComponentDeclarations, type ComponentDeclaration } from '@pragmatic-tech-ai/pragmatic-component'
import { TenantRoles } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

/**
 * The component descriptor of the tenant admin image (pragmatic-tenant-admind, the console that ships into a client hive):
 * the `TenantAdminEnv` contract as `TenantAdminServer`, `InjectedIdpService` and `IngressTlsPolicy` read it. Stores in
 * Postgres (A5). Settings that bind the console to the platform, to its trust roots or to its own storage (the rollout link
 * and its token, the injected IdP, the release descriptors, keys and registry, the state folder and the database URL) are the platform's, injected by the hive manifests: they are
 * left out of the descriptor, so no tenant configuration can set them. Declares its application role (`environment-admin`; the tenant role `admin` is the realm's own). The port and base domain
 * have no default and are injected by the hive manifests (7100 is the port the console installer gives it), so a configuration
 * names them only to change them.
 */
export class TenantAdminComponent
{
    public static readonly Name = 'pragmatic-tenant-admin'
    /** The descriptor version: this application's package version (the release test pins it to package.json). */
    public static readonly Version = '0.1.3'

    /** The declaration: the descriptor, and the variable the start step overlays each configured setting onto. */
    public static readonly Declaration: ComponentDeclaration = {
        name: TenantAdminComponent.Name,
        version: TenantAdminComponent.Version,
        options: [
            {
                name: 'core',
                description: 'The tenant console: listener, state folder and tenant origins.',
                settings: [
                    { name: 'portalDir', type: SettingType.String, source: 'PRAGMATIC_TENANT_ADMIN_PORTAL_DIR', description: 'The tenant portal bundle (defaults to the shipped admin/tenant-portal/dist).' },
                    { name: 'port', type: SettingType.Integer, source: 'PRAGMATIC_TENANT_ADMIN_PORT', description: 'Port of the tenant listener.' },
                    { name: 'baseDomain', type: SettingType.String, source: 'PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN', description: 'Tenants are served at <tenant>.<baseDomain>.' },
                    { name: 'bind', type: SettingType.String, source: 'PRAGMATIC_TENANT_ADMIN_BIND', default: '127.0.0.1', description: 'Address of the tenant listener.' },
                    { name: 'externalScheme', type: SettingType.String, source: 'PRAGMATIC_TENANT_ADMIN_EXTERNAL_SCHEME', default: 'https', description: 'Scheme browsers use for tenant origins.' },
                    { name: 'externalPort', type: SettingType.Integer, source: 'PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT', description: 'Port browsers use for tenant origins, when not the scheme default.' },
                    { name: 'secureCookie', type: SettingType.Boolean, source: 'PRAGMATIC_TENANT_ADMIN_SECURE_COOKIE', default: false, description: 'Whether session cookies are Secure.' },
                    { name: 'trustedProxy', type: SettingType.Boolean, source: 'PRAGMATIC_TENANT_ADMIN_TRUSTED_PROXY', default: false, description: 'Whether the tenant listener sits behind a trusted proxy.' },
                    { name: 'secretTtlHours', type: SettingType.Integer, source: 'PRAGMATIC_TENANT_ADMIN_SECRET_TTL_HOURS', default: 168, description: 'Lifetime of issued tenant secrets, in hours.' },
                    { name: 'healthProbeMs', type: SettingType.Integer, source: 'PRAGMATIC_TENANT_ADMIN_HEALTH_PROBE_MS', default: 30000, description: 'Interval of environment health probes, in milliseconds.' },
                    { name: 'healthProbeTimeoutMs', type: SettingType.Integer, source: 'PRAGMATIC_TENANT_ADMIN_HEALTH_PROBE_TIMEOUT_MS', default: 60000, description: 'Timeout of one environment health probe, in milliseconds.' },
                    { name: 'consoleHost', type: SettingType.String, source: 'PRAGMATIC_TENANT_ADMIN_CONSOLE_HOST', description: 'Browser host the console is served on through its Ingress.' },
                    { name: 'desktopRealmSignIn', type: SettingType.Boolean, source: 'PRAGMATIC_TENANT_ADMIN_DESKTOP_REALM_SIGN_IN', description: 'Whether desktop apps sign in through the realm (unset keeps the default of the console: on when the realm sign-in service is co-hosted).' },
                    { name: 'fingerprintKey', type: SettingType.String, source: 'PRAGMATIC_TENANT_ADMIN_FINGERPRINT_KEY_FILE', secret: true, description: 'The account-email fingerprint key (a mounted secret file).' },
                ],
            },
            {
                name: 'ingressTls',
                description: 'TLS of the environment and IdP Ingresses this console renders.',
                settings: [
                    { name: 'source', type: SettingType.String, source: 'PRAGMATIC_TENANT_ADMIN_INGRESS_TLS_SOURCE', required: true, description: 'existing-secret, cert-manager or development.' },
                    { name: 'secretName', type: SettingType.String, source: 'PRAGMATIC_TENANT_ADMIN_INGRESS_TLS_SECRET', description: 'The TLS Secret (for existing-secret).' },
                    { name: 'clusterIssuer', type: SettingType.String, source: 'PRAGMATIC_TENANT_ADMIN_INGRESS_TLS_ISSUER', description: 'The cert-manager ClusterIssuer (for cert-manager).' },
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
