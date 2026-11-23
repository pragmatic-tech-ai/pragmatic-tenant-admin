/** Orders component versions (`major.minor.patch[-prerelease]`, semver precedence; build metadata ignored). */
export class ComponentVersionOrder
{
    private static readonly Pattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
    private static readonly PrereleaseSeparator = '.'
    private static readonly Numeric = /^\d+$/

    /** Whether `version` is a later version than `than`; false when either does not read as a version. */
    public static IsNewer(version: string, than: string): boolean
    {
        const compared = ComponentVersionOrder.Compare(version, than)
        return compared !== undefined && compared > 0
    }

    /** Negative, zero or positive; undefined when either does not read as a version. */
    public static Compare(a: string, b: string): number | undefined
    {
        const O = ComponentVersionOrder
        const x = O.Pattern.exec(a)
        const y = O.Pattern.exec(b)
        if (x === null || y === null) return undefined
        for (let i = 1; i <= 3; i += 1)
        {
            const d = Number(x[i]) - Number(y[i])
            if (d !== 0) return d
        }
        return O.ComparePrerelease(x[4], y[4])
    }

    // A release follows its prereleases; prerelease identifiers compare numerically when both are numbers, else as text.
    private static ComparePrerelease(a: string | undefined, b: string | undefined): number
    {
        const O = ComponentVersionOrder
        if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1
        const x = a.split(O.PrereleaseSeparator)
        const y = b.split(O.PrereleaseSeparator)
        for (let i = 0; i < Math.min(x.length, y.length); i += 1)
        {
            const xn = O.Numeric.test(x[i])
            const yn = O.Numeric.test(y[i])
            const d = xn && yn ? Number(x[i]) - Number(y[i]) : xn ? -1 : yn ? 1 : x[i].localeCompare(y[i])
            if (d !== 0) return d
        }
        return x.length - y.length
    }
}
