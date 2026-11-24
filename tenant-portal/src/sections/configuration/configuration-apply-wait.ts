// How the configuration page waits while the console its own apply restarted comes back: the time now, a delay between
// reads, and the timeout of one read. Timers in the browser; a simulated clock in tests.
export interface IConfigurationApplyWait
{
    Now(): number
    Delay(ms: number): Promise<void>
    /** Resolves when the read `settled` follows has taken `ms` (it then counts as unanswered); never once it settles. */
    Timeout(ms: number, settled: Promise<unknown>): Promise<void>
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

    // The timer is cleared once the read settles, so no timer outlives its read.
    public Timeout(ms: number, settled: Promise<unknown>): Promise<void>
    {
        return new Promise(resolve =>
        {
            const timer = setTimeout(resolve, ms)
            const clear = (): void => { clearTimeout(timer) }
            settled.then(clear, clear)
        })
    }
}
