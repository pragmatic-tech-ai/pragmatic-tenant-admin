import { HttpsKubeTransport, InClusterServiceAccount, KubeApiClient, type IKubeTransport } from '@pragmatic-tech-ai/pragmatic-kube'
import { BootstrapSettings } from './bootstrap-settings.js'
import { EngineBootstrap, type IRandomSource } from './engine-bootstrap.js'
import { OpenSslTlsMinter, type ITlsMinter } from './tls-minter.js'

/** Where the CLI writes its lines (stdout in the Job; a recorder in tests). */
export interface IBootstrapOutput
{
    Line(text: string): void
}

export class ConsoleBootstrapOutput implements IBootstrapOutput
{
    public Line(text: string): void
    {
        console.log(text)
    }
}

/**
 * `pragmatic-tenant-admind bootstrap`: the engine chart's bootstrap hook over the Job's service account. Prints the Secrets
 * it created, kept and refreshed by name (never a value) and exits 0, or one line naming the failure (never a value) and 1.
 */
export class BootstrapCli
{
    public static readonly Command = 'bootstrap'
    private static readonly CreatedPrefix = 'created '
    private static readonly KeptPrefix = 'kept '
    private static readonly RefreshedPrefix = 'refreshed '
    private static readonly FailedPrefix = 'bootstrap failed: '
    private static readonly OutsideCluster = 'bootstrap failed: no in-cluster service account (it runs as the chart\'s bootstrap Job)'
    private static readonly DoneTemplate = 'bootstrap done: {created} created, {kept} kept, {refreshed} refreshed'
    private static readonly CreatedToken = '{created}'
    private static readonly KeptToken = '{kept}'
    private static readonly RefreshedToken = '{refreshed}'

    private constructor()
    {
    }

    public static async Run(env: NodeJS.ProcessEnv, output: IBootstrapOutput, transport?: IKubeTransport, tls: ITlsMinter = new OpenSslTlsMinter(), random?: IRandomSource): Promise<number>
    {
        const C = BootstrapCli
        try
        {
            const settings = BootstrapSettings.From(env)
            const kube = transport ?? C.InClusterTransport(env)
            if (kube === undefined)
            {
                output.Line(C.OutsideCluster)
                return 1
            }
            const report = await new EngineBootstrap(new KubeApiClient(kube), settings, tls, random).Run()
            report.Created.forEach(name => output.Line(C.CreatedPrefix + name))
            report.Kept.forEach(name => output.Line(C.KeptPrefix + name))
            report.Refreshed.forEach(name => output.Line(C.RefreshedPrefix + name))
            output.Line(C.DoneTemplate
                .replace(C.CreatedToken, String(report.Created.length))
                .replace(C.KeptToken, String(report.Kept.length))
                .replace(C.RefreshedToken, String(report.Refreshed.length)))
            return 0
        }
        catch (error)
        {
            output.Line(C.FailedPrefix + (error instanceof Error ? error.message : String(error)))
            return 1
        }
    }

    private static InClusterTransport(env: NodeJS.ProcessEnv): IKubeTransport | undefined
    {
        const account = InClusterServiceAccount.Detect(env)
        return account === undefined ? undefined : new HttpsKubeTransport(account)
    }
}
