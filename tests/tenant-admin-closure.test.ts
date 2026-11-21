import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { EsbuildLocator } from '@pragmatic-tech-ai/pragmatic-release-toolkit'

/** The slice of esbuild's plugin API the probe uses: third-party packages stay external, ours are followed. */
interface IResolveArgs
{
    path: string
}

interface IPluginBuild
{
    onResolve(options: { filter: RegExp }, callback: (args: IResolveArgs) => { path: string; external: boolean } | undefined): void
}

interface IProbeEsbuild
{
    build(options: Record<string, unknown>): Promise<{ metafile: { inputs: Record<string, unknown> } }>
}

/**
 * Bundles the entry point (nothing written), following this repository's files and every @pragmatic-tech-ai package
 * (the shared packages, TODL, Mural, ...), third-party packages and node built-ins external, and returns every source
 * file it loaded.
 */
class ClosureProbe
{
    private static readonly Root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    private static readonly OwnScope = '@pragmatic-tech-ai/'
    private static readonly BarePackage = /^[^./]/
    private static readonly PluginName = 'third-party-external'
    private static readonly Platform = 'node'
    private static readonly Format = 'esm'
    private static readonly LogLevel = 'silent'
    private static readonly Utf8 = 'utf8'

    public static async InputsOf(entry: string): Promise<string[]>
    {
        const P = ClosureProbe
        const esbuild = EsbuildLocator.Load(P.Root) as unknown as IProbeEsbuild
        const result = await esbuild.build({
            entryPoints: [entry],
            absWorkingDir: P.Root,
            bundle: true,
            platform: P.Platform,
            format: P.Format,
            metafile: true,
            write: false,
            outdir: tmpdir(),
            logLevel: P.LogLevel,
            plugins: [{
                name: P.PluginName,
                setup: (build: IPluginBuild) => build.onResolve({ filter: P.BarePackage }, args =>
                    args.path.startsWith(P.OwnScope) ? undefined : { path: args.path, external: true }),
            }],
        })
        return Object.keys(result.metafile.inputs)
    }

    /** The source text of a loaded file (its metafile path is relative to the repository). */
    public static TextOf(input: string): string
    {
        return readFileSync(join(ClosureProbe.Root, input), ClosureProbe.Utf8)
    }
}

/**
 * The in-hive tenant admin (pragmatic-tenant-admind) runs in a client's Kubernetes hive, so its import closure must not
 * carry the dev-box drivers (pragmatic-server's tenant-admin-closure test, archived with it): the Docker environment / IdP
 * drivers, the docker image-digest shell-out, and the kind CLI with its image loader and orchestrator and the platform
 * orchestrator factory. Those live in pragmatic-platform-admin now, so no file of this repository can import them; what
 * this guards is that no package the console reaches (pragmatic-tenant-plane above all) brings one back. Matched by the
 * classes those files declare. kubectl (pragmatic-kube's KubectlCli) is an allowed tool, not a dev-box driver.
 */
class Forbidden
{
    public static readonly Entry = 'src/bin/pragmatic-tenant-admind.ts'
    public static readonly EntrySeenMessage = 'the probe saw the entry point itself'
    public static readonly PlaneSeenMessage = 'the probe followed pragmatic-tenant-plane'
    public static readonly PlaneMarker = 'pragmatic-tenant-plane'
    private static readonly Separator = ': '
    public static readonly Classes: readonly string[] = [
        'DockerEnv',
        'ChildProcessSpawn',
        'DockerEnvAdapter',
        'DockerIdpDriver',
        'IdpContainerEnv',
        'ExecFileDockerExec',
        'DockerImageDigest',
        'RegistryRefImageDigest',
        'KindImageLoader',
        'KindCli',
        'KindHiveOrchestrator',
        'PlatformHiveOrchestratorFactory',
    ]

    /** `<file>: <class>` for each forbidden class a loaded source file declares. */
    public static DeclaredIn(inputs: readonly string[]): string[]
    {
        const F = Forbidden
        return inputs.flatMap(input =>
        {
            const text = ClosureProbe.TextOf(input)
            return F.Classes.filter(name => new RegExp(`\\bclass ${name}\\b`).test(text)).map(name => input + F.Separator + name)
        })
    }
}

describe('tenant-admin closure', () =>
{
    it('tenant-admin closure carries no dev-box drivers', async () =>
    {
        const inputs = await ClosureProbe.InputsOf(Forbidden.Entry)
        assert.ok(inputs.includes(Forbidden.Entry), Forbidden.EntrySeenMessage)
        assert.ok(inputs.some(path => path.includes(Forbidden.PlaneMarker)), Forbidden.PlaneSeenMessage)
        assert.deepEqual(Forbidden.DeclaredIn(inputs), [])
    })
})
