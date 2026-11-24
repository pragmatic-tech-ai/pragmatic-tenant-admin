import { IntervalAdvertTimer, type IAdvertTimer } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

/** What the schedule runs: every target of every component prepared for the release's descriptors. */
export interface IPreparesAll
{
    PrepareAll(tenantId: string): Promise<unknown>
}

/** A timer subscription the schedule ends at Stop. */
type Subscription = ReturnType<IAdvertTimer['Every']>

/**
 * Prepares every configuration again every IntervalMs while the console runs, besides at start and after every apply and
 * revert (C3.1 Ledger R7). What a target runs changes without the console: the platform's installer rolls the realm
 * sign-in service onto the release after the console prepared it, and only then is its running descriptor known, so the
 * entry prepared for the descriptor it ran before can go. A preparation that changes nothing writes nothing; one still
 * running when the timer fires again is not started twice.
 */
export class PreparationSchedule
{
    public static readonly IntervalMs = 10 * 60 * 1000
    private static readonly FailedPrefix = '[configuration] preparing again failed: '

    private subscription: Subscription | undefined
    private running: Promise<void> | undefined

    public constructor(
        private readonly preparer: IPreparesAll,
        private readonly log: (line: string) => void,
        private readonly timer: IAdvertTimer = new IntervalAdvertTimer(),
    )
    {
    }

    public Start(tenantId: string): void
    {
        if (this.subscription !== undefined) return
        this.subscription = this.timer.Every(PreparationSchedule.IntervalMs, () => this.Tick(tenantId))
    }

    /** Ends the schedule and waits for a preparation in flight. */
    public async Stop(): Promise<void>
    {
        this.subscription?.dispose()
        this.subscription = undefined
        await this.running
    }

    private Tick(tenantId: string): void
    {
        if (this.running !== undefined) return
        this.running = this.preparer.PrepareAll(tenantId)
            .then(() => undefined, err => this.log(PreparationSchedule.FailedPrefix + (err instanceof Error ? err.message : String(err))))
            .finally(() => { this.running = undefined })
    }
}
