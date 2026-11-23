/**
 * Serializes the console's read-modify-writes of one `pragmatic-config-<component>` ConfigMap (by namespace and name):
 * the applier's write and revert, and the preparer's write, each read the object and write it whole under one field
 * manager, so two of them interleaved would lose the other's change. One console process serves a tenant, so an
 * in-process lock suffices; the preparer also sends the resourceVersion it read, so a writer outside it is caught too.
 */
export class ConfigMapWriteLock
{
    private readonly tails = new Map<string, Promise<void>>()

    /** Runs `body` once every earlier body for `path` has ended (however it ended). */
    public async Run<T>(path: string, body: () => Promise<T>): Promise<T>
    {
        const previous = this.tails.get(path) ?? Promise.resolve()
        let release: () => void = () => undefined
        const mine = new Promise<void>(resolve => { release = resolve })
        const tail = previous.then(() => mine)
        this.tails.set(path, tail)
        await previous
        try
        {
            return await body()
        }
        finally
        {
            release()
            if (this.tails.get(path) === tail) this.tails.delete(path)
        }
    }
}
