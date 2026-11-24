import { ApiError } from '../tenant-api-client.js'

// Why the console has no link to Pragmatic, as the tenant API names it in the
// error `code` of a rollout route (a chart-installed engine, C3.2).
export enum EngineConnectionCode
{
    // A standalone engine: it never contacts Pragmatic (the routes answer 404).
    Standalone = 'engine-standalone',
    // A connected engine whose hive is not enrolled yet (503).
    NotEnrolled = 'hive-not-enrolled',
}

// Reads a failed rollout read as the engine's connection state.
export class EngineConnection
{
    private constructor()
    {
    }

    public static IsStandalone(e: unknown): boolean
    {
        return e instanceof ApiError && e.Status === ApiError.NotFoundStatus && e.Code === EngineConnectionCode.Standalone
    }

    public static IsNotEnrolled(e: unknown): boolean
    {
        return e instanceof ApiError && e.Status === ApiError.UnavailableStatus && e.Code === EngineConnectionCode.NotEnrolled
    }
}
