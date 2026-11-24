import { BootstrapCli, ConsoleBootstrapOutput } from './bootstrap/bootstrap-cli.js'
import { TenantAdminServer } from './tenant-admin-server.js'

/** `pragmatic-tenant-admind [bootstrap]`: no argument serves the console; `bootstrap` runs the engine chart's bootstrap and exits. */
export class TenantAdminCommand
{
    private constructor()
    {
    }

    public static async Run(argv: readonly string[]): Promise<void>
    {
        if (argv[0] === BootstrapCli.Command)
        {
            process.exitCode = await BootstrapCli.Run(process.env, new ConsoleBootstrapOutput())
            return
        }
        await TenantAdminServer.Main()
    }
}
