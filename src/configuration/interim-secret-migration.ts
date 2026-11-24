import { SecretReference } from '@pragmatic-tech-ai/pragmatic-component'
import type { RealmSecretWriter } from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeResourceCatalog, type KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import { RealmSecretName } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { ComponentConfigurationMounts, type ConfigurationComponentSummaryDto, type ConfigurationService } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

/** How the move of one component's interim secrets ended. */
export enum InterimSecretMigrationOutcome
{
    /** Every key is in the realm home, every target runs a configuration that refers to it there, the Secrets are gone. */
    Moved = 'moved',
    /** Nothing to move (no interim Secret, or an empty one). */
    Nothing = 'nothing',
    /** Two targets hold different values under one key: a realm secret has one value, so nothing was moved. */
    Conflict = 'conflict',
    /** A key is not a realm secret name (one lowercase segment): nothing was moved. */
    BadName = 'bad-name',
    /** A target's apply did not complete: its Secret stays (its pods still read it), the move resumes at the next start. */
    ApplyFailed = 'apply-failed',
}

/** One component's move, by names only (never a value). */
export class InterimSecretMigrationReport
{
    public constructor(public readonly Component: string, public readonly Outcome: InterimSecretMigrationOutcome, public readonly Keys: readonly string[], public readonly Targets: readonly string[])
    {
        Object.freeze(this)
    }
}

/** One target's interim Secret: its keys and values (decoded). */
class InterimSecret
{
    public constructor(public readonly Target: ConfigurationComponentSummaryDto['targets'][number], public readonly Path: string, public readonly Values: ReadonlyMap<string, string>)
    {
    }
}

/**
 * Moves the C3.1 interim homes of secret values (the Kubernetes Secrets `pragmatic-secrets-<component>` the console wrote
 * per target namespace, store `file`) into the realm's secrets home, once, at the console's start when the hive has a
 * realm secrets home. Per component: every key of its Secrets is written to the realm home (refused when two targets hold
 * different values under one key, or a key is not a realm secret name); then, per target that has a configuration
 * applied, a new version whose `secret:file/<key>` references read `secret:realm/<key>` is saved and applied (the apply
 * waits for the roll); only a target whose apply completed loses its Secret, so a failed apply keeps the interim Secret
 * its pods still read. The head from before the move is saved again rewritten, so a draft keeps its edits.
 * Idempotent: a run after a complete move finds no Secret; one after a partial move resumes it.
 */
export class InterimSecretMigration
{
    private static readonly SecretType = { apiVersion: 'v1', kind: 'Secret' }
    private static readonly Base64 = 'base64'
    private static readonly Utf8 = 'utf8'
    private static readonly FileStore = 'file'
    private static readonly RealmStore = 'realm'
    private static readonly Author = 'pragmatic-tenant-admin'
    private static readonly Comment = 'secret references moved to the realm secrets home'
    private static readonly AppliedOutcome = 'applied'

    public constructor(private readonly service: ConfigurationService, private readonly client: KubeApiClient, private readonly realm: RealmSecretWriter)
    {
    }

    public async Run(tenantId: string): Promise<readonly InterimSecretMigrationReport[]>
    {
        const reports: InterimSecretMigrationReport[] = []
        for (const summary of await this.service.List(tenantId))
        {
            reports.push(await this.Move(tenantId, summary))
        }
        return reports
    }

    private async Move(tenantId: string, summary: ConfigurationComponentSummaryDto): Promise<InterimSecretMigrationReport>
    {
        const component = summary.component
        const secrets: InterimSecret[] = []
        for (const target of summary.targets)
        {
            const found = await this.Read(component, target)
            if (found !== undefined && found.Values.size > 0) secrets.push(found)
        }
        const keys = [...new Set(secrets.flatMap(secret => [...secret.Values.keys()]))].sort()
        const names = secrets.map(secret => secret.Target.environment)
        if (keys.length === 0) return new InterimSecretMigrationReport(component, InterimSecretMigrationOutcome.Nothing, [], [])
        if (keys.some(key => !RealmSecretName.IsName(key))) return new InterimSecretMigrationReport(component, InterimSecretMigrationOutcome.BadName, keys, names)
        const values = new Map<string, string>()
        for (const secret of secrets)
        {
            for (const [key, value] of secret.Values)
            {
                const seen = values.get(key)
                if (seen !== undefined && seen !== value) return new InterimSecretMigrationReport(component, InterimSecretMigrationOutcome.Conflict, keys, names)
                values.set(key, value)
            }
        }
        for (const [key, value] of values)
        {
            await this.realm.Put(key, value)
        }
        const draft = summary.head
        let failed = false
        for (const secret of secrets)
        {
            if (await this.Repoint(tenantId, component, secret, keys))
            {
                await this.client.Delete(secret.Path)
            }
            else
            {
                failed = true
            }
        }
        if (draft !== null) await this.RewriteDraft(tenantId, component, draft, keys)
        return new InterimSecretMigrationReport(component, failed ? InterimSecretMigrationOutcome.ApplyFailed : InterimSecretMigrationOutcome.Moved, keys, names)
    }

    // The target runs a configuration whose references read the realm home: true when nothing had to change or the apply
    // of the rewritten version completed.
    private async Repoint(tenantId: string, component: string, secret: InterimSecret, keys: readonly string[]): Promise<boolean>
    {
        const I = InterimSecretMigration
        const applied = secret.Target.applied
        if (applied === null) return true
        const version = await this.service.Version(tenantId, component, applied)
        const rewritten = I.Rewritten(version.document, keys)
        if (JSON.stringify(rewritten) === JSON.stringify(version.document)) return true
        const head = (await this.service.Component(tenantId, component)).versions.at(-1)!.version
        const saved = await this.service.Save(tenantId, component, head, rewritten, I.Author, I.Comment, version.componentVersion)
        const outcome = await this.service.Apply(tenantId, component, saved.version, secret.Target.environment, I.Author)
        return outcome.outcome === I.AppliedOutcome
    }

    // The head from before the move (a draft no target may run yet) is saved again rewritten, so it stays the head with its
    // edits; nothing is saved when it is already the newest version in that form.
    private async RewriteDraft(tenantId: string, component: string, draft: number, keys: readonly string[]): Promise<void>
    {
        const I = InterimSecretMigration
        const before = await this.service.Version(tenantId, component, draft)
        const rewritten = I.Rewritten(before.document, keys)
        const head = (await this.service.Component(tenantId, component)).versions.at(-1)!
        const current = await this.service.Version(tenantId, component, head.version)
        if (JSON.stringify(rewritten) === JSON.stringify(current.document) && current.componentVersion === before.componentVersion) return
        await this.service.Save(tenantId, component, head.version, rewritten, I.Author, I.Comment, before.componentVersion)
    }

    private async Read(component: string, target: ConfigurationComponentSummaryDto['targets'][number]): Promise<InterimSecret | undefined>
    {
        const I = InterimSecretMigration
        const path = KubeResourceCatalog.PathOf(I.SecretType, target.namespace, ComponentConfigurationMounts.SecretNameOf(component))
        const found = await this.client.Get(path) as { data?: Record<string, string> } | undefined
        if (found === undefined) return undefined
        const values = new Map<string, string>()
        for (const [key, encoded] of Object.entries(found.data ?? {}))
        {
            values.set(key, Buffer.from(encoded, I.Base64).toString(I.Utf8))
        }
        return new InterimSecret(target, path, values)
    }

    /** The document with every `secret:file/<key>` of `keys` reading `secret:realm/<key>`; anything else as it was. */
    public static Rewritten(document: unknown, keys: readonly string[]): unknown
    {
        const I = InterimSecretMigration
        if (typeof document === 'string')
        {
            const reference = SecretReference.TryParse(document)
            return reference !== undefined && reference.Store === I.FileStore && reference.Version === undefined && keys.includes(reference.Name)
                ? new SecretReference(I.RealmStore, reference.Name).Format()
                : document
        }
        if (Array.isArray(document)) return document.map(entry => I.Rewritten(entry, keys))
        if (document !== null && typeof document === 'object')
        {
            return Object.fromEntries(Object.entries(document).map(([name, value]) => [name, I.Rewritten(value, keys)]))
        }
        return document
    }
}
