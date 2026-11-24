import { SecretReference } from '@pragmatic-tech-ai/pragmatic-component'
import { ApplyOutcome, ApplyTarget, ComponentStartConfiguration, ConfigurationHeadMovedError, RealmSecretsDirectory } from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeContentType, KubeResourceCatalog, type KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import { RealmSecretName, type IRealmSecretStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { ComponentConfigurationMounts, type ConfigurationComponentSummaryDto, type ConfigurationService } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { TenantAdminComponent } from '../tenant-admin-component.js'
import { RealmCapableComponents } from './realm-capable-components.js'
import { EveryRealmHomeWorkload, type IRealmHomeWorkloads } from './realm-home-workloads.js'

/** How the move of one component's interim secrets ended. */
export enum InterimSecretMigrationOutcome
{
    /** Every movable key is in the realm home, every target refers to it there, the moved keys left the Secrets. */
    Moved = 'moved',
    /** Nothing to move (no interim Secret, or an empty one). */
    Nothing = 'nothing',
    /** A key the realm home does not hold has different values (two targets or components): nothing of this component
     *  moved. A realm secret has one value; the tenant admin enters the one it should have in the console, then it moves. */
    Conflict = 'conflict',
    /** Some keys are not realm secret names (one lowercase segment): those stay in the interim Secret, the others moved. */
    BadName = 'bad-name',
    /** A target's rewritten configuration did not apply (or could not be saved, or its Secret not read): its Secret stays
     *  (its pods still read it); the move resumes at the next start. */
    ApplyFailed = 'apply-failed',
    /** A target runs a version that cannot read the realm secrets home: it keeps its interim Secret until it is upgraded. */
    AwaitingUpgrade = 'awaiting-upgrade',
    /** The console's own apply is still being proven: its own target moves at a later start. */
    AwaitingSelfApply = 'awaiting-self-apply',
}

/** One component's move, by names only (never a value). */
export class InterimSecretMigrationReport
{
    public constructor(
        public readonly Component: string,
        public readonly Outcome: InterimSecretMigrationOutcome,
        public readonly Keys: readonly string[],
        public readonly Targets: readonly string[],
        /** Keys the realm home already held with another value: the home's value is the realm's (the interim one goes). */
        public readonly Differing: readonly string[] = [])
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

/** One component's interim Secrets, or that they could not be read. */
class ComponentSecrets
{
    public constructor(public readonly Summary: ConfigurationComponentSummaryDto, public readonly Secrets: readonly InterimSecret[], public readonly Unreadable: boolean)
    {
    }
}

/**
 * Moves the C3.1 interim homes of secret values (the Kubernetes Secrets `pragmatic-secrets-<component>` the console wrote
 * per target namespace, store `file`) into the realm's secrets home, at the console's start when the hive has one.
 *
 * A realm secret has one value for the whole realm. A value the realm home already holds is the realm's (a tenant admin
 * entered it since, or an earlier run moved it): it is never overwritten, and the targets are re-pointed to it (the
 * keys are reported as `Differing` when the interim value was another). A key the home does not hold, with different
 * values over the components' Secrets, moves nothing of the components holding it (`conflict`) until a tenant admin
 * enters its value. Keys that are no realm secret names stay where they are (`bad-name`). Only targets whose running
 * version reads the realm home are re-pointed (`awaiting-upgrade` otherwise): per target, a version whose
 * `secret:file/<key>` references read `secret:realm/<key>` is saved for the component version the target runs (any
 * existing version of that document and component version is reused) and applied, which waits for the roll. A
 * target's moved keys leave its Secret only once its apply completed and neither its applied version nor the head still
 * refers to them as files (the Secret goes when it is empty). A failure of one target or component (a Secret that does
 * not read, an apply in progress, a refused apply, a save that lost a race twice) leaves its Secret and moves on; the
 * next start resumes. The console's own component goes last (its apply restarts this console) and waits while its own
 * apply is still being proven. The head from before the move, when no target runs it (a draft), is saved again
 * rewritten so it stays the head with its edits, unless a target still awaits an upgrade or its version cannot read the
 * realm home. Idempotent.
 */
export class InterimSecretMigration
{
    private static readonly SecretType = { apiVersion: 'v1', kind: 'Secret' }
    private static readonly Base64 = 'base64'
    private static readonly Utf8 = 'utf8'
    private static readonly DataKey = 'data'
    private static readonly Comment = 'secret references moved to the realm secrets home'

    public constructor(
        private readonly service: ConfigurationService,
        private readonly client: KubeApiClient,
        private readonly home: IRealmSecretStore,
        private readonly self?: IConsoleSelfTarget,
        private readonly capable: RealmCapableComponents = RealmCapableComponents.Default,
        private readonly workloads: IRealmHomeWorkloads = new EveryRealmHomeWorkload())
    {
    }

    public async Run(tenantId: string): Promise<readonly InterimSecretMigrationReport[]>
    {
        const I = InterimSecretMigration
        const summaries = [...await this.service.List(tenantId)]
            .sort((a, b) => Number(a.component === TenantAdminComponent.Name) - Number(b.component === TenantAdminComponent.Name))
        const components: ComponentSecrets[] = []
        for (const summary of summaries)
        {
            components.push(await this.Gather(summary))
        }
        const held = await this.Held(components)
        const conflicts = I.Conflicts(components, held)
        const reports: InterimSecretMigrationReport[] = []
        for (const entry of components)
        {
            const keys = I.KeysOf(entry.Secrets)
            const targets = entry.Secrets.map(secret => secret.Target.environment)
            if (entry.Unreadable || held === undefined)
            {
                reports.push(new InterimSecretMigrationReport(entry.Summary.component, InterimSecretMigrationOutcome.ApplyFailed, keys, targets))
                continue
            }
            try
            {
                reports.push(await this.Move(tenantId, entry, held, conflicts))
            }
            catch
            {
                // Whatever failed for this component (listing its versions, its draft), the others still move.
                reports.push(new InterimSecretMigrationReport(entry.Summary.component, InterimSecretMigrationOutcome.ApplyFailed, keys, targets))
            }
        }
        return reports
    }

    // A component's interim Secrets; a Secret that does not read marks the component unreadable (it then moves nothing).
    private async Gather(summary: ConfigurationComponentSummaryDto): Promise<ComponentSecrets>
    {
        const secrets: InterimSecret[] = []
        try
        {
            for (const target of summary.targets)
            {
                const secret = await this.Read(summary.component, target)
                if (secret !== undefined && secret.Values.size > 0) secrets.push(secret)
            }
            return new ComponentSecrets(summary, secrets, false)
        }
        catch
        {
            return new ComponentSecrets(summary, secrets, true)
        }
    }

    // What the realm home holds under every movable key; undefined when the home does not answer (nothing moves).
    private async Held(components: readonly ComponentSecrets[]): Promise<ReadonlyMap<string, string | null> | undefined>
    {
        const held = new Map<string, string | null>()
        try
        {
            for (const key of InterimSecretMigration.KeysOf(components.flatMap(entry => entry.Secrets)))
            {
                if (RealmSecretName.IsName(key)) held.set(key, await this.home.Get(key))
            }
            return held
        }
        catch
        {
            return undefined
        }
    }

    // Movable keys the home does not hold, with more than one value over every component's Secrets.
    private static Conflicts(components: readonly ComponentSecrets[], held: ReadonlyMap<string, string | null> | undefined): ReadonlySet<string>
    {
        const values = new Map<string, string>()
        const conflicts = new Set<string>()
        for (const secret of components.flatMap(entry => entry.Secrets))
        {
            for (const [key, value] of secret.Values)
            {
                if (!RealmSecretName.IsName(key) || (held?.get(key) ?? null) !== null) continue
                const seen = values.get(key)
                if (seen !== undefined && seen !== value) conflicts.add(key)
                values.set(key, value)
            }
        }
        return conflicts
    }

    private async Move(tenantId: string, entry: ComponentSecrets, held: ReadonlyMap<string, string | null>, conflicts: ReadonlySet<string>): Promise<InterimSecretMigrationReport>
    {
        const I = InterimSecretMigration
        const summary = entry.Summary
        const component = summary.component
        const secrets = entry.Secrets
        const keys = I.KeysOf(secrets)
        const targets = secrets.map(secret => secret.Target.environment)
        if (keys.length === 0) return new InterimSecretMigrationReport(component, InterimSecretMigrationOutcome.Nothing, [], [])
        if (keys.some(key => conflicts.has(key))) return new InterimSecretMigrationReport(component, InterimSecretMigrationOutcome.Conflict, keys.filter(key => conflicts.has(key)), targets)
        const movable = keys.filter(key => RealmSecretName.IsName(key))
        const unmovable = keys.filter(key => !RealmSecretName.IsName(key))
        const differing = new Set<string>()
        for (const secret of secrets)
        {
            for (const [key, value] of secret.Values)
            {
                if (!movable.includes(key)) continue
                const current = held.get(key) ?? await this.home.Get(key)
                if (current === null) await this.home.Put(key, value)
                else if (current !== value) differing.add(key)
            }
        }
        let failed = false
        let upgrade = false
        let self = false
        for (const secret of secrets)
        {
            // A target that cannot read the home yet (an older version, or a workload not given the home's settings) waits.
            if (!this.capable.Reads(component, secret.Target.componentVersion) || !await this.workloads.Gives(component, secret.ApplyTarget))
            {
                upgrade = true
                continue
            }
            if (this.self !== undefined && this.self.Is(secret.ApplyTarget) && this.self.Proving)
            {
                self = true
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
        const draft = summary.head
        if (draft !== null && !upgrade && !summary.targets.some(target => target.applied === draft)) await this.RewriteDraft(tenantId, component, draft, movable)
        const outcome = failed ? InterimSecretMigrationOutcome.ApplyFailed
            : upgrade ? InterimSecretMigrationOutcome.AwaitingUpgrade
            : self ? InterimSecretMigrationOutcome.AwaitingSelfApply
            : unmovable.length > 0 ? InterimSecretMigrationOutcome.BadName : InterimSecretMigrationOutcome.Moved
        return new InterimSecretMigrationReport(component, outcome, outcome === InterimSecretMigrationOutcome.BadName ? unmovable : keys, targets, [...differing].sort())
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
        const number = await this.Existing(tenantId, component, rewritten, componentVersion) ?? await this.Save(tenantId, component, rewritten, componentVersion)
        const outcome = await this.service.Apply(tenantId, component, number, secret.Target.environment, TenantAdminComponent.Name)
        return outcome.outcome === ApplyOutcome.Applied
    }

    // A saved version of that document for that component version (an earlier target's, or an earlier run's).
    private async Existing(tenantId: string, component: string, document: unknown, componentVersion: string): Promise<number | undefined>
    {
        const I = InterimSecretMigration
        for (const version of [...(await this.service.Component(tenantId, component)).versions].reverse())
        {
            if (version.componentVersion !== componentVersion) continue
            if (I.Same((await this.service.Version(tenantId, component, version.version)).document, document)) return version.version
        }
        return undefined
    }

    // A new head with `document`; once more when another save landed first.
    private async Save(tenantId: string, component: string, document: unknown, componentVersion: string): Promise<number>
    {
        const I = InterimSecretMigration
        for (let attempt = 0; ; attempt++)
        {
            const head = (await this.service.Component(tenantId, component)).versions.at(-1)
            try
            {
                return (await this.service.Save(tenantId, component, head?.version ?? 0, document, TenantAdminComponent.Name, I.Comment, componentVersion)).version
            }
            catch (error)
            {
                if (!(error instanceof ConfigurationHeadMovedError) || attempt > 0) throw error
            }
        }
    }

    // The moved keys leave the target's Secret once nothing it runs or the head still reads them as files; the Secret goes
    // when a re-read finds it empty (a key written meanwhile stays).
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
        await this.client.Patch(secret.Path, { [I.DataKey]: Object.fromEntries(free.map(key => [key, null])) }, KubeContentType.MergePatch)
        const left = await this.client.Get(secret.Path) as { data?: Record<string, string> } | undefined
        if (left !== undefined && Object.keys(left.data ?? {}).length === 0) await this.client.Delete(secret.Path)
    }

    // The draft saved again rewritten (for its own component version, which must read the realm home), unless the head
    // already is that.
    private async RewriteDraft(tenantId: string, component: string, draft: number, keys: readonly string[]): Promise<void>
    {
        const I = InterimSecretMigration
        const before = await this.service.Version(tenantId, component, draft)
        if (!this.capable.Reads(component, before.componentVersion)) return
        const rewritten = I.Rewritten(before.document, keys)
        const head = (await this.service.Component(tenantId, component)).versions.at(-1)!
        const current = await this.service.Version(tenantId, component, head.version)
        if (I.Same(rewritten, current.document) && current.componentVersion === before.componentVersion) return
        await this.Save(tenantId, component, rewritten, before.componentVersion)
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
