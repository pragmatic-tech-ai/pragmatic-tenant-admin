/** Where an engine Secret lives: the engine's namespace (the chart's release namespace) or the realm sign-in service's. */
export enum EngineSecretScope
{
    Engine = 'engine',
    Idp = 'idp',
}

/**
 * How the bootstrap keeps a Secret. Minted: created once with fresh random material and never replaced (a replaced master
 * key leaves every sealed secret unreadable, a replaced password locks the data out). Copied: derived from another Secret
 * (a minted one, or the operator's TLS Secret) and refreshed on every run, so it follows its source.
 */
export enum EngineSecretOrigin
{
    Minted = 'minted',
    Copied = 'copied',
}

/** One engine Secret: its name, namespace scope, keys, type and origin. Names and keys only; never a value. */
export type EngineSecretSpec = {
    readonly Name: string
    readonly Scope: EngineSecretScope
    readonly Keys: readonly string[]
    readonly Type: string
    readonly Origin: EngineSecretOrigin
}

/**
 * The names and keys of every Secret the engine chart's bootstrap Job keeps: the one home of the names the chart's
 * templates mount (its tests read the rendered chart against this list). Every one carries `helm.sh/resource-policy: keep`
 * and `app.kubernetes.io/managed-by: pragmatic-engine`, so `helm uninstall` leaves them and a reinstall finds the data.
 */
export class EngineSecretSet
{
    public static readonly OpaqueType = 'Opaque'
    public static readonly TlsType = 'kubernetes.io/tls'
    public static readonly PasswordKey = 'password'
    public static readonly DatabaseUrlKey = 'database-url'
    public static readonly MasterKeyKey = 'master.key'
    public static readonly FingerprintKeyKey = 'fingerprint.key'
    public static readonly SigningKeyKey = 'signing-key.pem'
    public static readonly AdminTokenKey = 'admin-token'
    public static readonly SeedKey = 'seed.json'
    public static readonly EmailKey = 'email'
    public static readonly CaKey = 'ca.crt'
    public static readonly ServerCertKey = 'server.crt'
    public static readonly ServerKeyKey = 'server.key'
    public static readonly TlsCertKey = 'tls.crt'
    public static readonly TlsKeyKey = 'tls.key'

    public static readonly PostgresSuperuser = 'pragmatic-postgres-superuser'
    public static readonly PostgresTenantAdmin = 'pragmatic-postgres-app-tenant-admin'
    public static readonly PostgresTenantIdp = 'pragmatic-postgres-app-tenant-idp'
    public static readonly TenantAdminMasterKey = 'pragmatic-tenant-admin-master-key'
    public static readonly TenantAdminFingerprint = 'pragmatic-tenant-admin-fingerprint'
    public static readonly TenantAdminSeed = 'pragmatic-tenant-admin-seed'
    public static readonly IdpMasterKey = 'pragmatic-tenant-idp-master-key'
    public static readonly IdpSigningKey = 'pragmatic-tenant-idp-signing-key'
    public static readonly IdpAdminToken = 'pragmatic-tenant-idp-admin-token'
    public static readonly IdpTls = 'pragmatic-tenant-idp-tls'
    public static readonly IdpCa = 'pragmatic-tenant-idp-ca'
    public static readonly IdpDatabase = 'pragmatic-tenant-idp-database'
    public static readonly DevCa = 'pragmatic-tls-dev-ca'
    public static readonly ConsoleTls = 'pragmatic-console-tls'
    public static readonly OwnerInitial = 'pragmatic-owner-initial'
    /** The custom realm secrets home (2.5): the realm master key (copied into the sign-in service's namespace) and its three roles. */
    public static readonly RealmMasterKey = 'pragmatic-realm-master-key'
    public static readonly PostgresRealmSecretsConsole = 'pragmatic-postgres-realm-secrets-console'
    public static readonly PostgresRealmSecretsIdp = 'pragmatic-postgres-realm-secrets-idp'
    public static readonly PostgresRealmSecretsEnvironments = 'pragmatic-postgres-realm-secrets-environments'
    public static readonly IdpRealmSecretsDatabase = 'pragmatic-tenant-idp-realm-secrets'

    public static readonly KeepAnnotation = 'helm.sh/resource-policy'
    public static readonly KeepValue = 'keep'
    public static readonly ManagedByLabel = 'app.kubernetes.io/managed-by'
    public static readonly ManagedByValue = 'pragmatic-engine'

    private constructor()
    {
    }

    /** Every Secret, in the order the bootstrap keeps them (a copy after its source). `tlsSecret` is the operator's, when given. */
    public static Specs(selfSigned: boolean, tlsSecret?: string): readonly EngineSecretSpec[]
    {
        const S = EngineSecretSet
        const E = EngineSecretScope.Engine
        const I = EngineSecretScope.Idp
        const M = EngineSecretOrigin.Minted
        const C = EngineSecretOrigin.Copied
        const db = [S.PasswordKey, S.DatabaseUrlKey]
        const specs: EngineSecretSpec[] = [
            { Name: S.PostgresSuperuser, Scope: E, Keys: db, Type: S.OpaqueType, Origin: M },
            { Name: S.PostgresTenantAdmin, Scope: E, Keys: db, Type: S.OpaqueType, Origin: M },
            { Name: S.PostgresTenantIdp, Scope: E, Keys: db, Type: S.OpaqueType, Origin: M },
            { Name: S.TenantAdminMasterKey, Scope: E, Keys: [S.MasterKeyKey], Type: S.OpaqueType, Origin: M },
            { Name: S.TenantAdminFingerprint, Scope: E, Keys: [S.FingerprintKeyKey], Type: S.OpaqueType, Origin: M },
            { Name: S.TenantAdminSeed, Scope: E, Keys: [S.SeedKey], Type: S.OpaqueType, Origin: M },
            { Name: S.IdpAdminToken, Scope: E, Keys: [S.AdminTokenKey], Type: S.OpaqueType, Origin: M },
            { Name: S.OwnerInitial, Scope: E, Keys: [S.EmailKey, S.PasswordKey], Type: S.OpaqueType, Origin: M },
            { Name: S.IdpMasterKey, Scope: I, Keys: [S.MasterKeyKey], Type: S.OpaqueType, Origin: M },
            { Name: S.IdpSigningKey, Scope: I, Keys: [S.SigningKeyKey], Type: S.OpaqueType, Origin: M },
            { Name: S.IdpTls, Scope: I, Keys: [S.CaKey, S.ServerCertKey, S.ServerKeyKey], Type: S.OpaqueType, Origin: M },
            // Minted whatever the realm secrets option, so a later switch to the custom home finds them; mounted only then.
            { Name: S.RealmMasterKey, Scope: E, Keys: [S.MasterKeyKey], Type: S.OpaqueType, Origin: M },
            { Name: S.PostgresRealmSecretsConsole, Scope: E, Keys: db, Type: S.OpaqueType, Origin: M },
            { Name: S.PostgresRealmSecretsIdp, Scope: E, Keys: db, Type: S.OpaqueType, Origin: M },
            { Name: S.PostgresRealmSecretsEnvironments, Scope: E, Keys: db, Type: S.OpaqueType, Origin: M },
            { Name: S.IdpCa, Scope: E, Keys: [S.CaKey], Type: S.OpaqueType, Origin: C },
            { Name: S.IdpAdminToken, Scope: I, Keys: [S.AdminTokenKey], Type: S.OpaqueType, Origin: C },
            { Name: S.IdpDatabase, Scope: I, Keys: [S.DatabaseUrlKey], Type: S.OpaqueType, Origin: C },
            { Name: S.RealmMasterKey, Scope: I, Keys: [S.MasterKeyKey], Type: S.OpaqueType, Origin: C },
            { Name: S.IdpRealmSecretsDatabase, Scope: I, Keys: [S.DatabaseUrlKey], Type: S.OpaqueType, Origin: C },
        ]
        if (selfSigned)
        {
            specs.push(
                { Name: S.DevCa, Scope: E, Keys: [S.CaKey], Type: S.OpaqueType, Origin: M },
                { Name: S.ConsoleTls, Scope: E, Keys: [S.TlsCertKey, S.TlsKeyKey], Type: S.TlsType, Origin: M },
                { Name: S.ConsoleTls, Scope: I, Keys: [S.TlsCertKey, S.TlsKeyKey], Type: S.TlsType, Origin: C },
            )
        }
        else if (tlsSecret !== undefined)
        {
            specs.push({ Name: tlsSecret, Scope: I, Keys: [S.TlsCertKey, S.TlsKeyKey], Type: S.TlsType, Origin: C })
        }
        return specs
    }

    /** The console's TLS Secret name: the operator's, or the minted self-signed one. */
    public static ConsoleTlsName(selfSigned: boolean, tlsSecret: string | undefined): string | undefined
    {
        return selfSigned ? EngineSecretSet.ConsoleTls : tlsSecret
    }
}
