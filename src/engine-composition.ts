import { PgSession } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { PostgresPoolFactory } from '@pragmatic-tech-ai/pragmatic-realm-custom'
import { K8sManifestBuilder, type EngineEnvironment, type IIdpService, type IngressTls, type TenantRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import type { KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import { IngressTlsCopies } from './ingress-tls-copies.js'
import { InitialOwnerSeeder } from './bootstrap/initial-owner-seeder.js'
import { EngineEnv, EngineMode } from './engine-mode.js'
import { HivePostgresProvisioner } from './environments/hive-postgres-provisioner.js'

/**
 * What a chart-installed management engine adds to the console (nothing for a console the platform pushed): its mode, the
 * release images and the hive's Postgres environments run on, and the seeding of the realm's first local admin.
 */
export class EngineComposition
{
    private static readonly ApplicationName = 'pragmatic-tenant-admin-provisioner'
    private static readonly PartialImages = 'the engine chart sets both PRAGMATIC_TENANT_ADMIN_ENV_SERVER_IMAGE and PRAGMATIC_TENANT_ADMIN_UI_UNPACK_IMAGE, or neither'

    private session: PgSession | undefined
    private seeder: InitialOwnerSeeder | undefined
    private copies: IngressTlsCopies | undefined

    private constructor(
        public readonly Mode: EngineMode | undefined,
        public readonly Environment: EngineEnvironment | undefined,
        private readonly hivePostgresUrlFile: string | undefined,
        private readonly ownerInitialDir: string | undefined)
    {
    }

    public static From(env: NodeJS.ProcessEnv): EngineComposition
    {
        const E = EngineEnv
        const server = E.OptionalOf(env, E.EnvServerImage)
        const unpack = E.OptionalOf(env, E.UiUnpackImage)
        if ((server === undefined) !== (unpack === undefined))
        {
            throw new Error(EngineComposition.PartialImages)
        }
        const environment = server !== undefined && unpack !== undefined ? { ServerImage: server, UiUnpackImage: unpack, IngressClass: E.OptionalOf(env, E.IngressClass) } : undefined
        return new EngineComposition(E.ModeOf(env), environment, E.OptionalOf(env, E.HivePostgresUrlFile), E.OptionalOf(env, E.OwnerInitialDir))
    }

    /** A standalone engine never dials home: no advert, no agent channel. */
    public get Standalone(): boolean
    {
        return this.Mode === EngineMode.Standalone
    }

    /** The provisioner over the hive Postgres superuser session, or undefined when the chart names no hive Postgres. */
    public async OpenProvisioner(): Promise<HivePostgresProvisioner | undefined>
    {
        if (this.hivePostgresUrlFile === undefined)
        {
            return undefined
        }
        const pool = await new PostgresPoolFactory({ UrlFile: this.hivePostgresUrlFile, ApplicationName: EngineComposition.ApplicationName }).Create()
        this.session = new PgSession(pool)
        return new HivePostgresProvisioner(this.session)
    }

    /** Starts seeding the realm and its Owner in the background (once; a no-op without the chart's initial sign-in). */
    public StartOwnerSeeding(idp: IIdpService, tenant: TenantRecord, log: (line: string) => void): void
    {
        if (this.ownerInitialDir === undefined || this.seeder !== undefined)
        {
            return
        }
        this.seeder = InitialOwnerSeeder.Over(idp, tenant, this.ownerInitialDir, log)
        void this.seeder.Run()
    }

    /**
     * Starts keeping the copies of the console's TLS Secret current in the sign-in service's namespace and every environment's
     * (a chart-installed engine with its own certificate Secret; a pushed console renews through the platform's install).
     */
    public StartTlsCopies(client: KubeApiClient | undefined, tenantId: string, tls: IngressTls | undefined, environments: () => readonly string[], log: (line: string) => void): void
    {
        if (this.Mode === undefined || client === undefined || tls?.secretName === undefined || this.copies !== undefined)
        {
            return
        }
        const namespaces = (): readonly string[] => [K8sManifestBuilder.IdpNameOf(tenantId), ...environments().map(name => K8sManifestBuilder.NamespaceOf(name))]
        this.copies = new IngressTlsCopies(client, K8sManifestBuilder.SystemNamespace, tls.secretName, namespaces, log)
        this.copies.Start()
    }

    public async Close(): Promise<void>
    {
        await this.copies?.Stop()
        this.copies = undefined
        this.seeder?.Stop()
        const session = this.session
        this.session = undefined
        await session?.Dispose()
    }
}
