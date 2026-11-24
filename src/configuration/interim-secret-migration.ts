import { SecretReference } from '@pragmatic-tech-ai/pragmatic-component'
import { ApplyOutcome, ApplyTarget, ComponentStartConfiguration, ConfigurationHeadMovedError, RealmSecretsDirectory } from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeContentType, KubeResourceCatalog, type KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import { RealmSecretName, type IRealmSecretStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { ComponentConfigurationMounts, type ConfigurationComponentSummaryDto, type ConfigurationService } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { TenantAdminComponent } from '../tenant-admin-component.js'
import { RealmCapableComponents } from './realm-capable-components.js'

/** How the move of one component's interim secrets ended. */
export enum InterimSecretMigrationOutcome
{
    /** Every movable key is in the realm home, every target refers to it there, the moved keys left the Secrets. */
    Moved = 'moved',
    /** Nothing to move (no interim Secret, or an empty one). */
    Nothing = 'nothing',
    /** A key holds different values (two targets or components, or the realm home already holds another): nothing of this
     *  component moved. A realm secret has one value; the tenant admin decides which (enter it in the console again). */
    Conflict = 'conflict',
    /** Some keys are not realm secret names (one lowercase segment): those stay in the interim Secret, the others moved. */
    BadName = 'bad-name',
    /** A target's rewritten configuration did not apply (or could not be saved): its Secret stays (its pods still read
     *  it); the move resumes at the next start. */
    ApplyFailed = 'apply-failed',
    /** A target runs a version that cannot read the realm secrets home: it keeps its interim Secret until it is upgraded. */
    AwaitingUpgrade = 'awaiting-upgrade',
}

/** One component's move, by names only (never a value). */
export class InterimSecretMigrationReport
{
    public constructor(public readonly Component: string, public readonly Outcome: InterimSecretMigrationOutcome, public readonly Keys: readonly string[], public readonly Targets: readonly string[])
    {
        Object.freeze(this)
    }
}

/** The console's own Deployment as the migration sees it: an apply there restarts this console. */
export interface IConsoleSelfTarget
{
    Is(target: ApplyTarget): boolean
    readonly Proving: boolean
}

type TargetDto = ConfigurationComponentSummaryDto['targets'][number]

/** One target's interim Secret: its keys and values (decoded). */
class InterimSecret
{
    public constructor(public readonly Component: string, public readonly Target: TargetDto, public readonly Path: string, public readonly Values: ReadonlyMap<string, string>)
    {
    }

    public get ApplyTarget(): ApplyTarget
    {
        return new ApplyTarget(this.Target.hive, this.Target.namespace, this.Target.deployment)
    }
}

/**
 * Moves the C3.1 interim homes of secret values (the Kubernetes Secrets `pragmatic-secrets-<component>` the console wrote
 * per target namespace, store `file`) into the realm's secrets home, at the console's start when the hive has one.
 *
 * A realm secret has one value for the whole realm, so the values are gathered over every component first: a key with
 * two values (two targets, two components, or the realm home already holding another) moves nothing of the components
 * holding it (`conflict`), and the realm home is written only where it holds nothing under that name, so a value a
 * tenant admin entered since is never overwritten. Keys that are no realm secret names stay where they are (`bad-name`).
 * Only targets whose running version reads the realm home are re-pointed (`awaiting-upgrade` otherwise): per target, a
 * version whose `secret:file/<key>` references read `secret:realm/<key>` is saved for the component version the target
 * runs (one such version per source version and component version, reused) and applied, which waits for the roll. A
 * target's moved keys leave its Secret only once its apply completed and neither its applied version nor the head still
 * refers to them as files (the Secret goes when it is empty). A failure of one target (an apply in progress, a refused
 * apply, a save that lost a race twice) leaves its Secret and moves on; the next start resumes. The console's own
 * component goes last (its apply restarts this console) and waits while its own apply is still being proven. The head
 * from before the move is saved again rewritten, so a draft keeps its edits. Idempotent.
 */
export class InterimSecretMigration
{
    private static readonly SecretType = { apiVersion: 'v1', kind: 'Secret' }
    private static readonly Base64 = 'base64'
    private static readonly Utf8 = 'utf8'
    private static readonly DataKey = 'data'
    private static readonly Comment = 'secret references moved to the realm secrets home'
    private static readonly VersionKeySeparator = '@'

    // The rewritten versions saved in this run, by source version and component version.
    private readonly saved = new Map<string, number>()

    public constructor(private readonly service: ConfigurationService, private readonly client: KubeApiClient, private readonly home: IRealmSecretStore, private readonly self?: IConsoleSelfTarget)
    {
    }

    public async Run(tenantId: string): Promise<readonly InterimSecretMigrationReport[]>
    {
        const I = InterimSecretMigration
        const summaries = [...await this.service.List(tenantId)]
            .sort((a, b) => Number(a.component === TenantAdminComponent.Name) - Number(b.component === TenantAdminComponent.Name))
        const found = new Map<string, InterimSecret[]>()
        for (const summary of summaries)
        {
            const secrets: InterimSecret[] = []
            for (const target of summary.targets)
            {
                const secret = await this.Read(summary.component, target)
                if (secret !== undefined && secret.Values.size > 0) secrets.push(secret)
            }
            found.set(summary.component, secrets)
        }
        const conflicts = await this.Conflicts([...found.values()].flat())
        const reports: InterimSecretMigrationReport[] = []
        for (const summary of summaries)
        {
            const secrets = found.get(summary.component)!
            try
            {
                reports.push(await this.Move(tenantId, summary, secrets, conflicts))
            }
            catch
            {
                // Whatever failed for this component (listing its versions, its draft), the others still move.
                reports.push(new InterimSecretMigrationReport(summary.component, InterimSecretMigrationOutcome.ApplyFailed, I.KeysOf(secrets), secrets.map(s => s.Target.environment)))
            }
        }
        return reports
    }

    // Keys with more than one value over every Secret, or a value the realm home holds differently.
    private async Conflicts(secrets: readonly InterimSecret[]): Promise<ReadonlySet<string>>
    {
        const values = new Map<string, string>()
        const conflicts = new Set<string>()
        for (const secret of secrets)
        {
            for (const [key, value] of secret.Values)
            {
                const seen = values.get(key)
                if (seen !== undefined && seen !== value) conflicts.add(key)
                values.set(key, value)
            }
        }
        for (const [key, value] of values)
        {
            if (conflicts.has(key) || !RealmSecretName.IsName(key)) continue
            const held = await this.home.Get(key)
            if (held !== null && held !== value) conflicts.add(key)
        }
        return conflicts
    }

    private async Move(tenantId: string, summary: ConfigurationComponentSummaryDto, secrets: readonly InterimSecret[], conflicts: ReadonlySet<string>): Promise<InterimSecretMigrationReport>
    {
        const I = InterimSecretMigration
        const component = summary.component
        const keys = I.KeysOf(secrets)
        const targets = secrets.map(secret => secret.Target.environment)
        if (keys.length === 0) return new InterimSecretMigrationReport(component, InterimSecretMigrationOutcome.Nothing, [], [])
        if (keys.some(key => conflicts.has(key))) return new InterimSecretMigrationReport(component, InterimSecretMigrationOutcome.Conflict, keys.filter(key => conflicts.has(key)), targets)
        const movable = keys.filter(key => RealmSecretName.IsName(key))
        const unmovable = keys.filter(key => !RealmSecretName.IsName(key))
        for (const secret of secrets)
        {
            for (const [key, value] of secret.Values)
            {
                if (movable.includes(key) && await this.home.Get(key) === null) await this.home.Put(key, value)
            }
        }
        const draft = summary.head
        let failed = false
        let waiting = false
        for (const secret of secrets)
        {
            if (!RealmCapableComponents.Reads(component, secret.Target.componentVersion))
            {
                waiting = true
                continue
            }
            if (this.self !== undefined && this.self.Is(secret.ApplyTarget) && this.self.Proving)
            {
                failed = true
                continue
            }
            try
            {
                if (await this.Repoint(tenantId, component, secret, movable)) await this.Release(tenantId, component, secret, movable)
                else failed = true
            }
            catch
            {
                failed = true
            }
        }
        // A head no target runs is a draft: it is saved again rewritten. One a target runs was rewritten with it.
        if (draft !== null && !summary.targets.some(target => target.applied === draft)) await this.RewriteDraft(tenantId, component, draft, movable)
        const outcome = failed
            ? InterimSecretMigrationOutcome.ApplyFailed
            : waiting ? InterimSecretMigrationOutcome.AwaitingUpgrade : unmovable.length > 0 ? InterimSecretMigrationOutcome.BadName : InterimSecretMigrationOutcome.Moved
        return new InterimSecretMigrationReport(component, outcome, outcome === InterimSecretMigrationOutcome.BadName ? unmovable : keys, targets)
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
        if (I.Same(rewritten, version.document)) return true
        // Saved for what the target runs (a release roll may have moved it past the applied version's component version).
        const componentVersion = secret.Target.componentVersion ?? version.componentVersion
        const number = await this.SaveRewritten(tenantId, component, `${applied}${I.VersionKeySeparator}${componentVersion}`, rewritten, componentVersion)
        const outcome = await this.service.Apply(tenantId, component, number, secret.Target.environment, TenantAdminComponent.Name)
        return outcome.outcome === ApplyOutcome.Applied
    }

    // One rewritten version per source version and component version: reused in this run, or the head when it already is
    // that document (a resumed run), else saved (once more when another save landed first).
    private async SaveRewritten(tenantId: string, component: string, key: string, document: unknown, componentVersion: string): Promise<number>
    {
        const I = InterimSecretMigration
        const known = this.saved.get(key)
        if (known !== undefined) return known
        for (let attempt = 0; ; attempt++)
        {
            const head = (await this.service.Component(tenantId, component)).versions.at(-1)
            if (head !== undefined && head.componentVersion === componentVersion && I.Same((await this.service.Version(tenantId, component, head.version)).document, document))
            {
                this.saved.set(key, head.version)
                return head.version
            }
            try
            {
                const saved = await this.service.Save(tenantId, component, head?.version ?? 0, document, TenantAdminComponent.Name, I.Comment, componentVersion)
                this.saved.set(key, saved.version)
                return saved.version
            }
            catch (error)
            {
                if (!(error instanceof ConfigurationHeadMovedError) || attempt > 0) throw error
            }
        }
    }

    // The moved keys leave the target's Secret once nothing it runs or the head still reads them as files.
    private async Release(tenantId: string, component: string, secret: InterimSecret, keys: readonly string[]): Promise<void>
    {
        const I = InterimSecretMigration
        const summary = (await this.service.List(tenantId)).find(entry => entry.component === component)
        const target = summary?.targets.find(entry => entry.environment === secret.Target.environment)
        const documents: unknown[] = []
        for (const version of [target?.applied ?? null, summary?.head ?? null])
        {
            if (version !== null) documents.push((await this.service.Version(tenantId, component, version)).document)
        }
        const free = keys.filter(key => secret.Values.has(key) && !documents.some(document => I.RefersToFile(document, key)))
        if (free.length === 0) return
        if (free.length === secret.Values.size)
        {
            await this.client.Delete(secret.Path)
            return
        }
        await this.client.Patch(secret.Path, { [I.DataKey]: Object.fromEntries(free.map(key => [key, null])) }, KubeContentType.MergePatch)
    }

    // The head from before the move (a draft no target may run yet) is saved again rewritten, so it stays the head with its
    // edits; nothing is saved when it is already the newest version in that form.
    private async RewriteDraft(tenantId: string, component: string, draft: number, keys: readonly string[]): Promise<void>
    {
        const I = InterimSecretMigration
        const before = await this.service.Version(tenantId, component, draft)
        const rewritten = I.Rewritten(before.document, keys)
        if (I.Same(rewritten, before.document)) return
        const head = (await this.service.Component(tenantId, component)).versions.at(-1)!
        const current = await this.service.Version(tenantId, component, head.version)
        if (I.Same(rewritten, current.document) && current.componentVersion === before.componentVersion) return
        await this.SaveRewritten(tenantId, component, `${draft}${I.VersionKeySeparator}${before.componentVersion}`, rewritten, before.componentVersion)
    }

    private async Read(component: string, target: TargetDto): Promise<InterimSecret | undefined>
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
        return new InterimSecret(component, target, path, values)
    }

    private static KeysOf(secrets: readonly InterimSecret[]): string[]
    {
        return [...new Set(secrets.flatMap(secret => [...secret.Values.keys()]))].sort()
    }

    private static Same(a: unknown, b: unknown): boolean
    {
        return JSON.stringify(a) === JSON.stringify(b)
    }

    /** Whether the document still refers to `key` in the `file` store (pinned or not). */
    public static RefersToFile(document: unknown, key: string): boolean
    {
        const I = InterimSecretMigration
        if (typeof document === 'string')
        {
            const reference = SecretReference.TryParse(document)
            return reference !== undefined && reference.Store === ComponentStartConfiguration.FileStore && reference.Name === key
        }
        if (Array.isArray(document)) return document.some(entry => I.RefersToFile(entry, key))
        if (document !== null && typeof document === 'object') return Object.values(document).some(value => I.RefersToFile(value, key))
        return false
    }

    /** The document with every unpinned `secret:file/<key>` of `keys` reading `secret:realm/<key>`; anything else as it was. */
    public static Rewritten(document: unknown, keys: readonly string[]): unknown
    {
        const I = InterimSecretMigration
        if (typeof document === 'string')
        {
            const reference = SecretReference.TryParse(document)
            return reference !== undefined && reference.Store === ComponentStartConfiguration.FileStore && reference.Version === undefined && keys.includes(reference.Name)
                ? new SecretReference(RealmSecretsDirectory.RealmStore, reference.Name).Format()
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
