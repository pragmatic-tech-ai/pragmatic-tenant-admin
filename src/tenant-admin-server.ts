import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UserSeeder, AdminProxy, WsAdminConnector, AuditRegistry, BundleBuilderAdapter, UserSeederAdapter, NoHostEnvironmentRuntime, EnvironmentRuntimeResolver, InClusterEnvironmentRuntime, EnvironmentPlacement, EnvironmentRegistry, EnvironmentService, GraphService, TenantGraphAccess, type IEnvironmentReach, HiveHealthProducer, HiveOrchestratorFactory, type InClusterOrchestration, IngressTlsPolicy, type IngressTls, IdpAdminClient, type IIdpService, MasterKeyFile, NetPortProbe, PortAllocator, TenantPlaneComposer, type HiveRecord, type TenantRecord, ConsoleFingerprint, ConsoleAdvertSender, HttpConsoleAdvertTransport, IntervalAdvertTimer, SeededConsoleAccounts, type IOwnerResetFollower, ConsoleEmailDomainStore, ConsoleFingerprintKeys, ConsoleRegistration, type IRecordMap, type IRolloutClient, TenantAdminEnv, TenantAdminClientRegistry, TenantHostResolver, type ConsoleHostAlias, type TenantPlane, TenantSessions, TenantHealthMonitor, TenantConsoleHost } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { InClusterEnvironmentReach } from './in-cluster-environment-reach.js'
import { HttpsKubeTransport, InClusterServiceAccount, KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import type { PinnedImageVerifier } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { InjectedIdpService } from './injected-idp-service.js'
import { UnconfiguredIdpService } from './unconfigured-idp-service.js'
import { ConsoleOwnerResetFollower } from './console-owner-reset-follower.js'
import type { SeededTenantDirectory } from './tenant-api/seeded-tenant-directory.js'
import { ConsoleDelivery } from './console-delivery.js'
import { TenantAdminDatabase, TenantAdminRegistry } from './tenant-admin-database.js'
import { TenantAdminImport } from './tenant-admin-import.js'
import { UnconfiguredRolloutClient } from './tenant-api/unconfigured-rollout-client.js'
import { HttpRolloutClient } from './tenant-api/http-rollout-client.js'
import { ConsoleConfiguration } from './configuration/console-configuration.js'
import { TenantAdminComponent } from './tenant-admin-component.js'
import { SecretVariable } from '@pragmatic-tech-ai/pragmatic-configuration'
import { ConsoleStartFallback } from './configuration/console-start-fallback.js'
import type { ConfigurationPreparer } from './configuration/configuration-preparer.js'
import type { ConsoleSelfApply } from './configuration/console-self-apply.js'
import { PreparationSchedule } from './configuration/preparation-schedule.js'
import { ReleaseDescriptorCatalogue } from './configuration/release-descriptor-catalogue.js'
import { EngineComposition } from './engine-composition.js'
import { EngineEnv, EngineMode } from './engine-mode.js'
import { EngineRolloutClient } from './tenant-api/engine-rollout-client.js'

export type TenantAdminConfig = {
    readonly dataRoot: string
    readonly port: number
    readonly bind: string
    readonly baseDomain: string
    readonly scheme: string
    /** The tenant origin's externally visible port, when it is not the scheme default (proxy-less runs). */
    readonly externalPort: number | undefined
    readonly secureCookie: boolean
    /** Whether the tenant listener is behind a trusted proxy (PRAGMATIC_TENANT_ADMIN_TRUSTED_PROXY). */
    readonly trustedProxy: boolean
    /** Whether /desktop/console names the realm's desktop sign-in (PRAGMATIC_TENANT_ADMIN_DESKTOP_REALM_SIGN_IN, the
     *  setting `desktopRealmSignIn`; unset is on). Off withholds only the advert: realm access tokens stay desktop bearers. */
    readonly desktopRealmSignIn: boolean
    readonly secretTtlHours: number
    readonly probeMs: number
    readonly probeTimeoutMs: number
    /** The console's own host (PRAGMATIC_TENANT_ADMIN_CONSOLE_HOST); it answers for the seeded tenant. */
    readonly consoleHost: string | undefined
    /** Path of the mounted account-email fingerprint key (PRAGMATIC_TENANT_ADMIN_FINGERPRINT_KEY_FILE); undefined outside a console pod. */
    readonly fingerprintKeyFile: string | undefined
    /** How environment Ingresses get TLS; undefined = none configured. */
    readonly ingressTls: IngressTls | undefined
}

/** Everything the console advert sender needs, once every setting is present and the key file is good. */
type AdvertSettings = {
    readonly url: string
    readonly token: string
    readonly hiveId: string
    readonly key: Buffer
    readonly consoleUrl: string
}

export type TenantAdminComposition = {
    /** The console as its own configuration target; undefined outside a pod. */
    readonly selfApply: ConsoleSelfApply | undefined
    /** Prepares the configurations for the release's descriptors at start; undefined outside a pod. */
    readonly preparer: ConfigurationPreparer | undefined
    /** Prepares them again while the console runs (what a target runs changes after the platform rolls it); undefined outside a pod. */
    readonly preparation: PreparationSchedule | undefined
    readonly directory: SeededTenantDirectory
    readonly rollout: IRolloutClient
    readonly plane: TenantPlane
    readonly host: TenantConsoleHost
    readonly monitor: TenantHealthMonitor | undefined
    readonly config: TenantAdminConfig
    /** How this console reaches environments in its own hive; undefined outside a pod. */
    readonly reach: IEnvironmentReach | undefined
    /** The console's own email domains (seeded from the tenant record until first saved). */
    readonly emailDomains: ConsoleEmailDomainStore
    /** Tells the control plane about this console; undefined unless every advert setting is present (a real console pod). */
    readonly advert: ConsoleAdvertSender | undefined
    /** The desktop relay's audit, loaded before the plane is built. */
    readonly desktopAudit: AuditRegistry
    /** The graph routes' audit, loaded before the plane is built. */
    readonly graphAudit: AuditRegistry
    /**
     * Whether the platform still takes this console's adverts (stored in the console's database): the advert sender
     * feeds it, and the host refuses the desktop surface and the relay while it is Refused. Without an advert sender it opens
     * Registered regardless of the file and does not gate the host (nothing could ever restore Registered).
     */
    readonly registration: ConsoleRegistration
    /** The console's own Postgres database; closed with the console. */
    readonly database: TenantAdminDatabase
    /** What a chart-installed engine adds (its mode, the hive Postgres, the Owner's seeding); empty for a pushed console. */
    readonly engine: EngineComposition
    /** The injected realm sign-in service (the Owner's seeding reaches it). */
    readonly idp: IIdpService
    /** The console's environments (the TLS copies follow them). */
    readonly environments: EnvironmentRegistry
    /** The API client over the pod's service account; undefined outside a pod. */
    readonly kube: KubeApiClient | undefined
}

/**
 * The standalone tenant-admin process: boots ONLY the tenant plane over its own data root. Tenant and hive identity
 * come from a seed file (`seed.json`) instead of the operator's PlatformDirectory, and rollout reads/actions go
 * through an injected IRolloutClient. There is no operator plane and no agent channel here.
 * It serves the Plexus desktop surface (`/desktop/*`, including the `/desktop/console` lookup of its one tenant); the
 * desktop relay to environments only in a pod, where the in-cluster reach exists (outside one it has no way to reach them).
 */
export class TenantAdminServer
{
    /** The in-hive console names its realm's desktop sign-in unless told not to (the co-hosted tenant plane defaults off). */
    private static readonly DesktopRealmSignInDefault = true
    private static readonly MissingEnvPrefix = 'Missing required environment variable: '
    private static readonly MissingMasterKeyPrefix = 'Tenant-admin master key file not found: '
    private static readonly ListeningTemplate = 'Tenant plane listening on {scheme}://{domain}:{port}/'
    private static readonly SchemeToken = '{scheme}'
    private static readonly DomainToken = '{domain}'
    private static readonly PortToken = '{port}'
    private static readonly EmptyString = ''
    private static readonly NoIdentityMessage = 'The seed names no hive for the in-cluster console.'
    private static readonly ConsoleUrlScheme = 'https://'
    private static readonly AdvertOffPrefix = '[console-advert] off: '
    /** Logged once at Compose when there is no advert sender, so the registration cannot gate the desktop. */
    public static readonly RegistrationGateOffLine = '[console-registration] gate off: the advert is not configured, so the registration never refuses the desktop'
    private static readonly NotSetSuffix = ' is not set'
    private static readonly BadKeyInfix = ' does not name a readable key file of '
    private static readonly BytesSuffix = ' bytes'
    private static readonly StandaloneReason = 'a standalone engine never contacts Pragmatic'

    private running: TenantAdminComposition | undefined
    /** The watch that proves (or puts back) the console's own apply this process was started by; ends at Close. */
    private selfReadiness: Promise<void> | undefined
    /** Whether Run opened the running composition's database (and Close therefore ends it). */
    private ownsDatabase = false

    public constructor(
        private readonly config: TenantAdminConfig,
        private readonly rollout: IRolloutClient)
    {
    }

    /** Entry point used by the bin: reads config from the environment and runs with the default rollout client. */
    public static async Main(): Promise<void>
    {
        // First of all: the applied configuration (the mounted pragmatic-config-pragmatic-tenant-admin) over the environment;
        // a configuration the console applied to itself that refuses its start is put back before it exits.
        const config = await ConsoleStartFallback.Start(TenantAdminComponent.Declaration, process.env, env => TenantAdminServer.ReadConfig(env))
        await new TenantAdminServer(config, TenantAdminServer.RolloutClientFrom(process.env)).Run()
    }

    /**
     * The HTTP rollout client when the agent-channel URL is configured (token + hive id then required); otherwise the default.
     * A standalone engine builds no agent-channel client at all (its routes answer 404), and a connected engine without the
     * URL is not enrolled yet (its routes answer 503 naming that).
     */
    public static RolloutClientFrom(env: NodeJS.ProcessEnv): IRolloutClient
    {
        const mode = EngineEnv.ModeOf(env)
        if (mode === EngineMode.Standalone)
        {
            return EngineRolloutClient.Standalone()
        }
        const url = env[TenantAdminEnv.RolloutUrl]
        if (url === undefined || url === TenantAdminServer.EmptyString)
        {
            return mode === EngineMode.Connected ? EngineRolloutClient.NotEnrolled() : TenantAdminServer.DefaultRolloutClient()
        }
        return new HttpRolloutClient(
            url,
            TenantAdminServer.RequiredSecret(env, TenantAdminEnv.RolloutToken),
            TenantAdminServer.Required(env, TenantAdminEnv.RolloutHiveId))
    }

    /** The default rollout client; the in-container HTTP client replaces it when the operator link is wired. */
    public static DefaultRolloutClient(): IRolloutClient
    {
        return new UnconfiguredRolloutClient()
    }

    /** Pure: derives the config from the environment; a missing required variable throws naming it. */
    public static ReadConfig(env: NodeJS.ProcessEnv): TenantAdminConfig
    {
        const dataRoot = TenantAdminServer.Required(env, TenantAdminEnv.DataRoot)
        const portRaw = TenantAdminServer.Required(env, TenantAdminEnv.Port)
        const baseDomain = TenantAdminServer.Required(env, TenantAdminEnv.BaseDomain)
        return {
            dataRoot,
            port: TenantPlaneComposer.ResolveTenantPort(portRaw),
            bind: TenantPlaneComposer.TenantBind(env[TenantAdminEnv.Bind]),
            baseDomain,
            scheme: TenantPlaneComposer.TenantScheme(env[TenantAdminEnv.Scheme]),
            externalPort: TenantPlaneComposer.TenantExternalPort(env[TenantAdminEnv.ExternalPort]),
            secureCookie: TenantPlaneComposer.ReadsTrue(env[TenantAdminEnv.SecureCookie]),
            trustedProxy: TenantPlaneComposer.ReadsTrue(env[TenantAdminEnv.TrustedProxy]),
            desktopRealmSignIn: TenantPlaneComposer.DesktopRealmSignInOf(env[TenantAdminEnv.DesktopRealmSignIn], TenantAdminServer.DesktopRealmSignInDefault),
            secretTtlHours: TenantPlaneComposer.ParseSecretTtlHours(env[TenantAdminEnv.SecretTtl]),
            probeMs: TenantPlaneComposer.ParseHealthProbeMs(env[TenantAdminEnv.HealthProbeMs]),
            probeTimeoutMs: TenantPlaneComposer.ParseHealthProbeTimeoutMs(env[TenantAdminEnv.HealthProbeTimeoutMs]),
            consoleHost: TenantAdminServer.OptionalOf(env, TenantAdminEnv.ConsoleHost),
            fingerprintKeyFile: TenantAdminServer.OptionalOf(env, TenantAdminEnv.FingerprintKeyFile),
            ingressTls: IngressTlsPolicy.FromEnv(env),
        }
    }

    /**
     * The console's advert sender: undefined (and one log line naming the missing setting's env var, never a value) unless
     * consoleHost, a ConsoleFingerprintKeys.KeyBytes key file and RolloutUrl / RolloutToken / RolloutHiveId are all present.
     * It dials home over the same agent channel, bearer and hive as the HTTP rollout client. consoleUrl = 'https://' + consoleHost.
     * Every 200 answer is handed to `follower` (the console's ConsoleOwnerResetFollower) when one is given, and every
     * outcome to `registration` (the console's ConsoleRegistration) when one is given. Building it attaches its transport as
     * `domains`' verify channel (see SenderFrom).
     */
    public static AdvertSenderOf(env: NodeJS.ProcessEnv, cfg: TenantAdminConfig, tenant: TenantRecord, domains: ConsoleEmailDomainStore, log: (line: string) => void = TenantAdminServer.LogLine, follower?: IOwnerResetFollower, registration?: ConsoleRegistration): ConsoleAdvertSender | undefined
    {
        const settings = TenantAdminServer.AdvertSettingsOf(env, cfg, log)
        return settings === undefined ? undefined : TenantAdminServer.SenderFrom(settings, tenant, domains, log, follower, registration)
    }

    /** The advert's settings, or undefined after one log line naming the first missing or bad one (never a value). */
    private static AdvertSettingsOf(env: NodeJS.ProcessEnv, cfg: TenantAdminConfig, log: (line: string) => void): AdvertSettings | undefined
    {
        const S = TenantAdminServer
        if (EngineEnv.ModeOf(env) === EngineMode.Standalone)
        {
            return S.AdvertOff(log, S.StandaloneReason)
        }
        const url = S.OptionalOf(env, TenantAdminEnv.RolloutUrl)
        const token = SecretVariable.Read(env, TenantAdminEnv.RolloutToken)
        const hiveId = S.OptionalOf(env, TenantAdminEnv.RolloutHiveId)
        if (cfg.consoleHost === undefined)
        {
            return S.AdvertOff(log, TenantAdminEnv.ConsoleHost + S.NotSetSuffix)
        }
        if (cfg.fingerprintKeyFile === undefined)
        {
            return S.AdvertOff(log, TenantAdminEnv.FingerprintKeyFile + S.NotSetSuffix)
        }
        if (url === undefined)
        {
            return S.AdvertOff(log, TenantAdminEnv.RolloutUrl + S.NotSetSuffix)
        }
        if (token === undefined)
        {
            return S.AdvertOff(log, TenantAdminEnv.RolloutToken + S.NotSetSuffix)
        }
        if (hiveId === undefined)
        {
            return S.AdvertOff(log, TenantAdminEnv.RolloutHiveId + S.NotSetSuffix)
        }
        const key = ConsoleFingerprint.ReadKeyFile(cfg.fingerprintKeyFile)
        if (key === undefined)
        {
            return S.AdvertOff(log, TenantAdminEnv.FingerprintKeyFile + S.BadKeyInfix + ConsoleFingerprintKeys.KeyBytes + S.BytesSuffix)
        }
        return { url, token, hiveId, key, consoleUrl: S.ConsoleUrlScheme + cfg.consoleHost }
    }

    /**
     * The sender over one agent-channel transport, which is also attached as `domains`' verify channel, so a Verify on this
     * console reaches the platform over the same channel, bearer and hive as the advert.
     */
    private static SenderFrom(settings: AdvertSettings, tenant: TenantRecord, domains: ConsoleEmailDomainStore, log: (line: string) => void, follower?: IOwnerResetFollower, registration?: ConsoleRegistration): ConsoleAdvertSender
    {
        const transport = new HttpConsoleAdvertTransport(settings.url, settings.token, settings.hiveId)
        domains.AttachVerifyChannel(transport)
        return new ConsoleAdvertSender(transport, new SeededConsoleAccounts(tenant), domains,
            settings.key, settings.consoleUrl, new IntervalAdvertTimer(), log, follower, registration)
    }

    /**
     * The console's registration and whether it gates the host. Only an advert answer can restore Registered, so without
     * an advert sender a saved Refused state could never clear: the registration then opens Registered without reading the
     * file (which is left alone), does not gate the desktop, and one fixed line says so.
     */
    private static async RegistrationOf(stored: IRecordMap<unknown>, advertConfigured: boolean, log: (line: string) => void): Promise<ConsoleRegistration>
    {
        if (advertConfigured)
        {
            // Never throws: a missing or bad record opens Registered, so the desktop is never locked out by it.
            return ConsoleRegistration.Open(stored, log)
        }
        log(TenantAdminServer.RegistrationGateOffLine)
        return ConsoleRegistration.OpenRegistered(stored, log)
    }

    /**
     * In-cluster the operator provisioned the IdP, so the pod only CONNECTS (injected env + mounted Secret files). Without that
     * injection there is no IdP: the console never launches one (that is the platform's job, and the dev-box Docker IdP
     * driver is not part of this app).
     */
    public static BuildIdpService(env: NodeJS.ProcessEnv): IIdpService
    {
        return InjectedIdpService.FromEnv(env) ?? new UnconfiguredIdpService()
    }

    /**
     * What the console needs to orchestrate its own hive through the Kubernetes API: the API client over the pod's service
     * account, the identity from the seed (tenant + the hive it was installed into) and the pinned-image allow-list the
     * platform delivered. No network call.
     */
    public static InClusterOrchestrationOf(account: InClusterServiceAccount, directory: SeededTenantDirectory, verifier: PinnedImageVerifier): InClusterOrchestration
    {
        const hive = TenantAdminServer.FirstHiveOf(directory)
        return {
            client: new KubeApiClient(new HttpsKubeTransport(account)),
            identity: { tenantId: hive.tenantId, hiveId: hive.id },
            verifier,
        }
    }

    /** The tenant portal bundle folder: PRAGMATIC_TENANT_ADMIN_PORTAL_DIR (resolved) when set, else the shipped `tenant-portal/dist` (beside `src` / `dist`). */
    public static PortalRootOf(env: NodeJS.ProcessEnv): string
    {
        const raw = env[TenantAdminEnv.PortalDir]?.trim() ?? TenantAdminServer.EmptyString
        if (raw !== TenantAdminServer.EmptyString)
        {
            return resolve(raw)
        }
        return join(dirname(fileURLToPath(import.meta.url)), TenantPlaneComposer.ParentSegment, TenantPlaneComposer.TenantPortalSegment, TenantPlaneComposer.DistSegment)
    }

    /**
     * Builds the whole tenant plane over the console's own database (opened from PRAGMATIC_TENANT_ADMIN_DATABASE_URL_FILE,
     * or the one given) without binding anything: the platform's delivery (seed, verified images), every store, services,
     * plane (with the desktop surface; its relay only in a pod), host, health monitor, the console's email domains, the
     * desktop and graph audits, the console registration (gating the host only when there is an advert sender) and (in a
     * configured console) its advert sender. A database that holds none of the console's records while the data root still
     * holds pre-A5 ones is imported first (TenantAdminImport.ImportIfPending; the files stay as the backup).
     */
    public async Compose(env: NodeJS.ProcessEnv = process.env, serviceAccountRoot?: string, log: (line: string) => void = TenantAdminServer.LogLine, database?: TenantAdminDatabase): Promise<TenantAdminComposition>
    {
        const cfg = this.config
        const dataRoot = cfg.dataRoot
        const keyPath = join(dataRoot, TenantPlaneComposer.MasterKeyFileName)
        if (!existsSync(keyPath))
        {
            throw new Error(TenantAdminServer.MissingMasterKeyPrefix + keyPath)
        }
        const masterKey = MasterKeyFile.Load(keyPath)
        const db = database ?? await TenantAdminDatabase.Open(env)
        const engine = EngineComposition.From(env)
        try
        {
            await TenantAdminImport.ImportIfPending(dataRoot, db, log)
            return await this.ComposeOver(db, masterKey, env, serviceAccountRoot, log, engine)
        }
        catch (err)
        {
            await engine.Close()
            if (database === undefined)
            {
                await db.Close()
            }
            throw err
        }
    }

    private async ComposeOver(db: TenantAdminDatabase, masterKey: Buffer, env: NodeJS.ProcessEnv, serviceAccountRoot: string | undefined, log: (line: string) => void, engine: EngineComposition): Promise<TenantAdminComposition>
    {
        const cfg = this.config
        const dataRoot = cfg.dataRoot
        const R = TenantAdminRegistry
        const directory = await ConsoleDelivery.Seed(dataRoot, await db.Map(R.DirectorySeed))
        const verifier = await ConsoleDelivery.VerifiedImages(dataRoot, await db.Map(R.VerifiedImages))
        // No host (Docker) backend: the console runs environments only in its own hive, so an unbound record never runs here.
        const noHost = new NoHostEnvironmentRuntime()
        const registry = new EnvironmentRegistry(await db.Map(R.Environments), noHost)
        await registry.Load()
        const adminClients = new TenantAdminClientRegistry(await db.Map(R.TenantAdminClients))
        await adminClients.Load()
        const idpService = TenantAdminServer.BuildIdpService(env)
        const account = InClusterServiceAccount.Detect(env, serviceAccountRoot)
        const inCluster = account === undefined ? undefined : TenantAdminServer.InClusterOrchestrationOf(account, directory, verifier)
        const orchestrators = inCluster === undefined ? new HiveOrchestratorFactory() : new HiveOrchestratorFactory(undefined, dataRoot, inCluster)
        // A chart-installed engine runs environments on the release's images and the hive's one Postgres.
        const placement = new EnvironmentPlacement(directory, cfg.ingressTls, undefined, engine.Environment)
        const databases = await engine.OpenProvisioner()
        const reach = inCluster === undefined ? undefined : new InClusterEnvironmentReach(orchestrators.For(TenantAdminServer.FirstHiveOf(directory)).Kubectl)
        // No PlatformImageSigner here, deliberately: the platform signing key's private half never ships into a hive, so
        // the in-hive tenant admin cannot sign. It runs only images the platform signed (its hive's verification decides).
        const proxy = new AdminProxy(new WsAdminConnector())
        const service = new EnvironmentService(registry, new PortAllocator(TenantPlaneComposer.EnvPortFloor, new NetPortProbe()), new EnvironmentRuntimeResolver(noHost, new InClusterEnvironmentRuntime(orchestrators, placement, directory, new BundleBuilderAdapter(), undefined, databases), directory, orchestrators), new UserSeederAdapter(new UserSeeder()), dataRoot, proxy, directory, idpService, conn => new IdpAdminClient(conn), undefined, reach)
        const tenant = directory.Tenant
        const emailDomains = await ConsoleEmailDomainStore.Open(await db.Map(R.EmailDomains), tenant.id, tenant.emailDomains)
        const desktopAudit = new AuditRegistry(await db.Map(R.DesktopAudit))
        await desktopAudit.Load()
        const graphAudit = new AuditRegistry(await db.Map(R.GraphAudit))
        await graphAudit.Load()
        // Graphs live in the environments, so outside a pod (no reach) the routes answer 503 instead of calling out.
        const graphs = new TenantGraphAccess(reach === undefined ? undefined : new GraphService(registry, proxy, service), graphAudit)
        // The desktop surface is always served; the relay only when this console can reach its environments (in a pod).
        const relay = reach === undefined ? undefined : { endpoints: reach, audit: desktopAudit }
        const resolver = new TenantHostResolver(cfg.baseDomain, cfg.scheme, directory, cfg.externalPort, TenantAdminServer.ConsoleAliasOf(cfg, directory))
        const sessions = new TenantSessions(await db.SessionRepositories(), cfg.secureCookie)
        // The console configures every hive component it finds by label, through its own cluster access; at start it prepares
        // their configurations for the descriptors of the release it runs (ConfigurationPreparer).
        const configuration = ConsoleConfiguration.Build({
            Env: env, Repository: await db.Configuration(), Environments: registry, TenantId: tenant.id,
            HiveId: TenantAdminServer.FirstHiveOf(directory).id, Client: inCluster?.client,
        }, log)
        const plane = TenantPlaneComposer.BuildTenantPlane({
            Idp: idpService,
            Directory: directory,
            Service: service,
            Rollout: this.rollout,
            Orchestrators: orchestrators,
            Placement: placement,
            Sessions: sessions,
            Resolver: resolver,
            FlowStates: await db.FlowStates(),
            ClientSecrets: { Store: await db.Secrets(masterKey), Registry: adminClients, TtlMs: TenantPlaneComposer.SecretTtlMsOf(cfg.secretTtlHours) },
            TrustedProxy: cfg.trustedProxy,
            Desktop: true,
            Relay: relay,
            EmailDomains: emailDomains,
            ConsoleTenantId: tenant.id,
            DesktopRealmSignIn: cfg.desktopRealmSignIn,
            Graphs: graphs,
            Configuration: configuration.Service,
        })
        const selfApply = configuration.Self
        const monitor = cfg.probeMs > 0
            ? new TenantHealthMonitor(directory, new HiveHealthProducer(service, orchestrators, placement), plane.events, cfg.probeMs, cfg.probeTimeoutMs, service)
            : undefined
        const advertSettings = TenantAdminServer.AdvertSettingsOf(env, cfg, log)
        const registration = await TenantAdminServer.RegistrationOf(await db.Map(R.Registration), advertSettings !== undefined, log)
        // No advert sender, no gate: nothing could ever lift a refusal.
        const host = new TenantConsoleHost({
            Plane: plane,
            Resolver: resolver,
            Service: service,
            PortalRoot: TenantAdminServer.PortalRootOf(env),
            Monitor: monitor,
            Registration: advertSettings === undefined ? undefined : registration,
            Audit: await db.Audit(),
            TrustedProxy: cfg.trustedProxy,
        })
        // An operator Owner reset reaches this console in the advert answer; the follower then ends the Owner's sessions, sockets
        // and relays (the host has attached both to plane.principals above).
        const follower = new ConsoleOwnerResetFollower(plane.principals, tenant, await db.Map(R.OwnerResetApplied))
        const advert = advertSettings === undefined ? undefined : TenantAdminServer.SenderFrom(advertSettings, tenant, emailDomains, log, follower, registration)
        return { directory, rollout: this.rollout, plane, host, monitor, config: cfg, reach, emailDomains, advert, desktopAudit, graphAudit, registration, database: db, selfApply, preparer: configuration.Preparer, engine, idp: idpService, environments: registry, kube: inCluster?.client,
            preparation: configuration.Preparer === undefined ? undefined : new PreparationSchedule(configuration.Preparer, log) }
    }

    /**
     * Composes, binds the tenant listener, then starts the advert (its first send awaited; a failure is logged, never thrown).
     * `database` replaces the one the environment names (tests).
     */
    public async Run(env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = TenantAdminServer.LogLine, database?: TenantAdminDatabase): Promise<TenantAdminComposition>
    {
        const composition = await this.Compose(env, undefined, log, database)
        const cfg = composition.config
        // An apply the console made to itself ended with its restart: settle what this console does not run before any new
        // apply can begin; the one it runs stays pending, with what ran before kept, until this console is proven ready.
        const repository = await composition.database.Configuration()
        const tenantId = composition.directory.Tenant.id
        const self = composition.selfApply
        const awaiting = self === undefined ? undefined : await self.Settle(repository, tenantId)
            .catch(err => TenantAdminServer.Logged(log, TenantAdminServer.SettleFailed, err))
        await self?.SettleInterrupted(repository, tenantId, ReleaseDescriptorCatalogue.HiveComponents)
            .catch(err => log(TenantAdminServer.SettleFailed + (err instanceof Error ? err.message : String(err))))
        try
        {
            await composition.host.Listen(cfg.port, cfg.bind)
        }
        catch (err)
        {
            // A console its own apply started that cannot even listen puts back what ran before, then stops.
            if (self !== undefined && awaiting !== undefined)
            {
                await self.AbandonOnce(repository, tenantId, awaiting)
                    .catch(failed => log(TenantAdminServer.SettleFailed + (failed instanceof Error ? failed.message : String(failed))))
            }
            await composition.engine.Close()
            if (database === undefined)
            {
                await composition.database.Close()
            }
            throw err
        }
        // Proven once its own Deployment has been ready for a while, else put back (in the background: serving goes on).
        this.selfReadiness = self === undefined || awaiting === undefined
            ? undefined
            : self.AwaitReady(repository, tenantId, awaiting)
                .then(outcome => log(TenantAdminServer.SelfApplyPrefix + outcome))
                .catch(err => log(TenantAdminServer.SettleFailed + (err instanceof Error ? err.message : String(err))))
        // Only a listener that bound counts as running, so Close after a failed Listen has nothing to stop.
        this.running = composition
        this.ownsDatabase = database === undefined
        console.log(TenantAdminServer.ListeningLine(cfg))
        // Serving first, then the configurations prepared for this release's descriptors: the platform's installer waits for
        // their status before it rolls the components onto the release (one target failing is logged, never fatal).
        await composition.preparer?.PrepareAll(tenantId)
            .catch(err => log(TenantAdminServer.PrepareFailed + (err instanceof Error ? err.message : String(err))))
        composition.preparation?.Start(tenantId)
        // A chart-installed engine seeds its realm and the Owner's one-time sign-in once the sign-in service answers.
        composition.engine.StartOwnerSeeding(composition.idp, composition.directory.Tenant, log)
        composition.engine.StartTlsCopies(composition.kube, tenantId, cfg.ingressTls, () => composition.environments.List().map(r => r.name), log)
        await composition.advert?.Start()
        return composition
    }

    /**
     * Stops the advert (aborting a send in flight and waiting for it to end, so nothing is logged afterwards), closes the
     * tenant listener started by Run (which also closes the desktop relay and awaits its pending audit writes), then the
     * database Run opened (even when closing the listener failed; a database the caller passed stays theirs); a no-op
     * when nothing runs.
     */
    public async Close(): Promise<void>
    {
        const composition = this.running
        this.running = undefined
        if (composition === undefined)
        {
            return
        }
        composition.advert?.Stop()
        await composition.advert?.Idle()
        composition.selfApply?.Stop()
        await composition.preparation?.Stop()
        await this.selfReadiness
        this.selfReadiness = undefined
        try
        {
            await composition.host.Close()
        }
        finally
        {
            await composition.engine.Close()
            if (this.ownsDatabase)
            {
                await composition.database.Close()
            }
        }
    }

    private static AdvertOff(log: (line: string) => void, reason: string): undefined
    {
        log(TenantAdminServer.AdvertOffPrefix + reason)
        return undefined
    }

    private static LogLine(line: string): void
    {
        console.error(line)
    }

    private static ListeningLine(cfg: TenantAdminConfig): string
    {
        return TenantAdminServer.ListeningTemplate
            .replace(TenantAdminServer.SchemeToken, cfg.scheme)
            .replace(TenantAdminServer.DomainToken, cfg.baseDomain)
            .replace(TenantAdminServer.PortToken, String(cfg.port))
    }

    private static ConsoleAliasOf(cfg: TenantAdminConfig, directory: SeededTenantDirectory): ConsoleHostAlias | undefined
    {
        return cfg.consoleHost === undefined ? undefined : { host: cfg.consoleHost, tenantId: TenantAdminServer.FirstHiveOf(directory).tenantId }
    }

    /** The seed's first hive: the console's own identity. Throws NoIdentityMessage when the seed has none. */
    private static FirstHiveOf(directory: SeededTenantDirectory): HiveRecord
    {
        const hive = directory.ListHives()[0]
        if (hive === undefined)
        {
            throw new Error(TenantAdminServer.NoIdentityMessage)
        }
        return hive
    }

    private static OptionalOf(env: NodeJS.ProcessEnv, name: string): string | undefined
    {
        const value = env[name]
        return value === undefined || value === TenantAdminServer.EmptyString ? undefined : value
    }

    /** A secret setting: its `_FILE` (where the start step writes a configured secret) or the plain variable. */
    private static RequiredSecret(env: NodeJS.ProcessEnv, name: string): string
    {
        const value = SecretVariable.Read(env, name)
        if (value === undefined)
        {
            throw new Error(TenantAdminServer.MissingEnvPrefix + name)
        }
        return value
    }

    private static readonly SettleFailed = 'settling the console\'s own configuration apply failed: '
    private static readonly SelfApplyPrefix = '[configuration] the console\'s own apply: '

    // Logs a failure and answers nothing (a settle that failed leaves nothing to watch).
    private static Logged(log: (line: string) => void, prefix: string, err: unknown): undefined
    {
        log(prefix + (err instanceof Error ? err.message : String(err)))
        return undefined
    }
    private static readonly PrepareFailed = 'preparing the configurations for this release failed: '

    private static Required(env: NodeJS.ProcessEnv, name: string): string
    {
        const value = env[name]
        if (value === undefined || value === TenantAdminServer.EmptyString)
        {
            throw new Error(TenantAdminServer.MissingEnvPrefix + name)
        }
        return value
    }
}
