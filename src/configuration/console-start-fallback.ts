import type { ComponentDeclaration } from '@pragmatic-tech-ai/pragmatic-component'
import { ApplyTarget, ComponentStartConfiguration, ConfigurationStartError, RealmSecretsDirectory, type ComponentStartReport, type IStartProcess, type SecretStoreDirectory } from '@pragmatic-tech-ai/pragmatic-configuration'
import { HttpsKubeTransport, InClusterServiceAccount, KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import { K8sManifestBuilder, TenantAdminEnv } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { TenantAdminComponent } from '../tenant-admin-component.js'
import { ConsoleSelfApply } from './console-self-apply.js'

/** Puts back what ran before the console's own configuration (ConsoleSelfApply.Revert); undefined outside a cluster. */
export interface IConsoleRevert
{
    Revert(): Promise<boolean>
}

/**
 * The console's start under its own configuration: the start step, then the settings readers (`read`). When either
 * refuses (the configuration does not read, validate or resolve; or a configured value the readers refuse), the console
 * first puts back what ran before (if it was started by its own apply, ConsoleSelfApply), so its Deployment is recreated
 * from the last good template, then exits 78 with the reason. The tenant is never left without a console by a
 * configuration it applied to itself. Outside a cluster there is nothing to put back.
 */
export class ConsoleStartFallback
{
    public static readonly RevertedNote = 'the previous configuration of the console was put back'
    public static readonly IgnoredNote = 'started without its applied configuration (validated for another console version, and it does not carry over): '
    public static readonly DroppedNote = 'started on its applied configuration of another console version, leaving behind the settings this version no longer has or refuses: '
    private static readonly NameSeparator = ', '
    /** The revert reads and writes by namespace and name only; the hive is not known before the console starts. */
    private static readonly LocalHive = 'local'
    private static readonly NoNote = ''
    private static readonly LineEnd = '\n'
    private static readonly ReasonSeparator = ': '
    private static readonly RevertFailed = 'putting back the previous configuration of the console failed'

    public static async Start<T>(declaration: ComponentDeclaration, env: NodeJS.ProcessEnv, read: (env: NodeJS.ProcessEnv) => T, revert: IConsoleRevert | undefined = ConsoleStartFallback.InCluster(env), process: IStartProcess = globalThis.process as unknown as IStartProcess): Promise<T>
    {
        const F = ConsoleStartFallback
        // `file` and, with a realm secrets home (2.5), `realm`. A home that fails its check (a replaced realm master key, no
        // projected token) refuses the start, but puts nothing back: the configuration is not what failed.
        let stores: SecretStoreDirectory
        try
        {
            stores = await RealmSecretsDirectory.Stores(declaration.name, env)
        }
        catch (error)
        {
            if (!(error instanceof ConfigurationStartError)) throw error
            process.stderr.write(declaration.name + F.ReasonSeparator + error.message + F.LineEnd)
            return process.exit(ComponentStartConfiguration.ExitCode)
        }
        try
        {
            // The console alone re-validates a configuration of its previous descriptor (it prepares everyone's entries, so nobody prepares its own).
            const report = await ComponentStartConfiguration.Apply({ Declaration: declaration, Env: env, Revalidate: true, Stores: stores })
            F.Tell(declaration, report, process)
            return read(env)
        }
        catch (error)
        {
            const reason = error instanceof Error ? error.message : String(error)
            let note = F.NoNote
            try
            {
                note = revert !== undefined && await revert.Revert() ? F.ReasonSeparator + F.RevertedNote : F.NoNote
            }
            catch
            {
                note = F.ReasonSeparator + F.RevertFailed
            }
            process.stderr.write(declaration.name + F.ReasonSeparator + reason + note + F.LineEnd)
            if (error instanceof ConfigurationStartError || note !== F.NoNote)
            {
                return process.exit(ComponentStartConfiguration.ExitCode)
            }
            throw error
        }
    }

    // A configuration of the console's previous version carried over or ignored is said on stderr (names only, never values).
    private static Tell(declaration: ComponentDeclaration, report: ComponentStartReport, process: IStartProcess): void
    {
        const F = ConsoleStartFallback
        if (report.Ignored !== undefined) process.stderr.write(declaration.name + F.ReasonSeparator + F.IgnoredNote + report.Ignored + F.LineEnd)
        if (report.Dropped.length > 0) process.stderr.write(declaration.name + F.ReasonSeparator + F.DroppedNote + report.Dropped.join(F.NameSeparator) + F.LineEnd)
    }

    /** The revert of the console's own Deployment, named by PRAGMATIC_TENANT_ADMIN_DEPLOYMENT (its manifest renders it). */
    public static InCluster(env: NodeJS.ProcessEnv): IConsoleRevert | undefined
    {
        const F = ConsoleStartFallback
        const account = InClusterServiceAccount.Detect(env)
        const deployment = F.DeploymentOf(env)
        if (account === undefined || deployment === undefined) return undefined
        const self = new ApplyTarget(F.LocalHive, K8sManifestBuilder.SystemNamespace, deployment)
        return new ConsoleSelfApply(new KubeApiClient(new HttpsKubeTransport(account)), self, TenantAdminComponent.Name)
    }

    /** The console's own Deployment name, when the environment names a valid one. */
    public static DeploymentOf(env: NodeJS.ProcessEnv): string | undefined
    {
        const F = ConsoleStartFallback
        const name = env[TenantAdminEnv.Deployment]
        if (name === undefined || name === F.NoNote) return undefined
        try
        {
            return new ApplyTarget(F.LocalHive, K8sManifestBuilder.SystemNamespace, name).Deployment
        }
        catch
        {
            return undefined
        }
    }
}
