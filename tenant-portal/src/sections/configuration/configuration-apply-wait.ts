// How the configuration page waits while the console its own apply restarted comes back: the time now, a delay between
// reads, and the timeout of one read. Timers in the browser; a simulated clock in tests.
export interface IConfigurationApplyWait
{
    Now(): number
    Delay(ms: number): Promise<void>
    /** Resolves when one read has taken `ms` (it then counts as unanswered). */
    Timeout(ms: number): Promise<void>
}

export class TimerConfigurationApplyWait implements IConfigurationApplyWait
{
    public Now(): number
    {
        return Date.now()
    }

    public Delay(ms: number): Promise<void>
    {
        return new Promise(resolve => { setTimeout(resolve, ms) })
    }

    public Timeout(ms: number): Promise<void>
    {
        return this.Delay(ms)
    }
}
