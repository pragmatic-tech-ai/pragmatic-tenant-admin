// How the configuration page waits between reads while the console its own apply restarted comes back: a timer in the
// browser, an instant one in tests.
export interface IConfigurationApplyWait
{
    Delay(ms: number): Promise<void>
}

export class TimerConfigurationApplyWait implements IConfigurationApplyWait
{
    public Delay(ms: number): Promise<void>
    {
        return new Promise(resolve => { setTimeout(resolve, ms) })
    }
}
