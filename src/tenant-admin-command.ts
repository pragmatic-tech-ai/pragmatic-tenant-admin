import { BootstrapCli, ConsoleBootstrapOutput } from './bootstrap/bootstrap-cli.js'
import { TenantAdminServer } from './tenant-admin-server.js'

/** `pragmatic-tenant-admind [bootstrap [namespace]]`: no argument serves the console; `bootstrap` runs the engine chart's bootstrap hook (`namespace`: its first step) and exits. */
export class TenantAdminCommand
{
    private constructor()
    {
    }

    public static async Run(argv: readonly string[]): Promise<void>
    {
        if (argv[0] === BootstrapCli.Command)
        {
            process.exitCode = await BootstrapCli.Run(process.env, new ConsoleBootstrapOutput(), undefined, undefined, undefined, argv[1])
            return
        }
        await TenantAdminServer.Main()
    }
}
