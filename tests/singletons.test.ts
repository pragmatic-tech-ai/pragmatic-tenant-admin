import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

/**
 * Walks the repository's installed node_modules (nested ones included) and counts the installed copies of each package
 * that must load once per process: two copies of TODL, Mural or todl-runtime split their registries and `instanceof`.
 */
class InstalledPackages
{
    public static readonly Singletons: readonly string[] = ['@pragmatic-tech-ai/todl', '@pragmatic-tech-ai/todl-runtime', '@pragmatic-tech-ai/mural']
    private static readonly Root = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules')
    private static readonly NodeModules = 'node_modules'
    private static readonly PackageJson = 'package.json'
    private static readonly ScopePrefix = '@'
    private static readonly HiddenPrefix = '.'
    private static readonly Utf8 = 'utf8'

    /** The install path of every copy of `name`. */
    public static CopiesOf(name: string): string[]
    {
        const found: string[] = []
        InstalledPackages.Walk(InstalledPackages.Root, name, found)
        return found
    }

    private static Walk(modules: string, name: string, found: string[]): void
    {
        const P = InstalledPackages
        if (!existsSync(modules))
        {
            return
        }
        for (const entry of readdirSync(modules, { withFileTypes: true }))
        {
            if (entry.name.startsWith(P.HiddenPrefix) || !(entry.isDirectory() || entry.isSymbolicLink()))
            {
                continue
            }
            const dirs = entry.name.startsWith(P.ScopePrefix)
                ? readdirSync(join(modules, entry.name)).map(child => join(modules, entry.name, child))
                : [join(modules, entry.name)]
            for (const dir of dirs)
            {
                P.Visit(dir, name, found)
            }
        }
    }

    private static Visit(dir: string, name: string, found: string[]): void
    {
        const P = InstalledPackages
        const manifest = join(dir, P.PackageJson)
        if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, P.Utf8)) as { name?: string }).name === name)
        {
            found.push(dir)
        }
        P.Walk(join(dir, P.NodeModules), name, found)
    }
}

describe('singletons', () =>
{
    for (const name of InstalledPackages.Singletons)
    {
        it(`one installed copy of ${name}`, () =>
        {
            const copies = InstalledPackages.CopiesOf(name)
            assert.equal(copies.length, 1, JSON.stringify(copies))
        })
    }
})
