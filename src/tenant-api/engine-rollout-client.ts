import { type AdoptionLedgerDto, type HiveRolloutStatus, type IRolloutClient, type ManifestRecord, RolloutStandaloneError, RolloutUnavailableCode, RolloutUnavailableError } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

/**
 * The rollout client of a chart-installed engine without an agent channel: Standalone (never connects; the routes answer
 * 404 with code `engine-standalone`) or Connected before enrolment (503 with code `hive-not-enrolled`, so the portal offers
 * "connect this hive"). No agent-channel client is built in either case.
 */
export class EngineRolloutClient implements IRolloutClient
{
    private static readonly StandaloneMessage = 'This hive runs standalone: it has no connection to Pragmatic. Upgrade it with helm upgrade.'
    private static readonly NotEnrolledMessage = 'This hive is not connected to Pragmatic yet. Connect it to receive releases.'

    private constructor(private readonly standalone: boolean)
    {
    }

    public static Standalone(): EngineRolloutClient
    {
        return new EngineRolloutClient(true)
    }

    public static NotEnrolled(): EngineRolloutClient
    {
        return new EngineRolloutClient(false)
    }

    public ManifestsFor(_tenantId: string): Promise<readonly ManifestRecord[]>
    {
        return Promise.reject(this.Error())
    }

    public StatusFor(_hiveId: string): Promise<HiveRolloutStatus>
    {
        return Promise.reject(this.Error())
    }

    public AdoptTarget(_hiveId: string, _version: string): Promise<void>
    {
        return Promise.reject(this.Error())
    }

    public LedgerFor(_hiveId: string, _limit: number): Promise<readonly AdoptionLedgerDto[]>
    {
        return Promise.reject(this.Error())
    }

    private Error(): RolloutUnavailableError
    {
        const E = EngineRolloutClient
        return this.standalone
            ? new RolloutStandaloneError(E.StandaloneMessage)
            : new RolloutUnavailableError(E.NotEnrolledMessage, RolloutUnavailableCode.NotEnrolled)
    }
}
