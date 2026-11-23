import { ComponentImageLabel, OciRegistryClient } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import type { IImageComponentDigests } from './label-configuration-targets.js'

/** Makes the registry client of one registry host. */
export interface IRegistryClients
{
    For(host: string): OciRegistryClient
}

/** Anonymous https clients (the platform images are public). */
export class PublicRegistryClients implements IRegistryClients
{
    private static readonly HttpsScheme = 'https://'

    public For(host: string): OciRegistryClient
    {
        return new OciRegistryClient(PublicRegistryClients.HttpsScheme + host)
    }
}

/**
 * The descriptor digest a running image carries, read from its `ai.pragmatic-tech.component.digest` label
 * (ComponentImageLabel) through the image's own registry. Only a digest-pinned reference (`<host>/<repo>@sha256:<hex>`)
 * is read, so the answer is about the bytes that run; a tag (a development image, `name:dev`) answers undefined, as does a
 * registry out of reach. Answers are kept per image digest (an image never changes under its digest).
 */
export class ImageComponentDigests implements IImageComponentDigests
{
    private static readonly Reference = /^([a-z0-9.-]+(?::[0-9]+)?)\/([a-z0-9._/-]+?)(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?@(sha256:[0-9a-f]{64})$/
    /** How long a read that failed is not tried again, and how long one read may take. */
    public static readonly FailureBackoffMs = 60_000
    public static readonly ReadTimeoutMs = 5_000
    private static readonly TimedOut = 'image label read timed out'

    private readonly known = new Map<string, string | undefined>()
    private readonly failedAt = new Map<string, number>()

    public constructor(private readonly clients: IRegistryClients = new PublicRegistryClients(), private readonly now: () => number = Date.now)
    {
    }

    public async DigestOf(image: string): Promise<string | undefined>
    {
        const match = ImageComponentDigests.Reference.exec(image)
        if (match === null) return undefined
        const [, host, repo, digest] = match
        if (this.known.has(digest)) return this.known.get(digest)
        const failed = this.failedAt.get(digest)
        if (failed !== undefined && this.now() - failed < ImageComponentDigests.FailureBackoffMs) return undefined
        let label: string | undefined
        try
        {
            label = await ImageComponentDigests.WithTimeout(ComponentImageLabel.Read(this.clients.For(host), repo, digest))
        }
        catch
        {
            this.failedAt.set(digest, this.now())
            return undefined
        }
        this.failedAt.delete(digest)
        this.known.set(digest, label)
        return label
    }

    private static WithTimeout<T>(read: Promise<T>): Promise<T>
    {
        let timer: NodeJS.Timeout | undefined
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(ImageComponentDigests.TimedOut)), ImageComponentDigests.ReadTimeoutMs) })
        return Promise.race([read, timeout]).finally(() => clearTimeout(timer))
    }
}
