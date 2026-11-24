import type { IEnvironmentIntentLog } from './environment-intent-endpoint.js'

/** The intent endpoint's log lines: an event and its code, never a token or a body. */
export class IntentEndpointLog implements IEnvironmentIntentLog
{
    private static readonly Prefix = '[intents] '
    private static readonly Separator = ': '
    private static readonly Empty = ''

    public constructor(private readonly log: (line: string) => void)
    {
    }

    public Event(event: string, code?: string): void
    {
        const L = IntentEndpointLog
        this.log(L.Prefix + event + (code === undefined ? L.Empty : L.Separator + code))
    }
}
