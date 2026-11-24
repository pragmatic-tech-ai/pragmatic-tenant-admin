import { CanonicalJson, ConfigurationValidator, type ComponentDescriptor, type ConfigurationError } from '@pragmatic-tech-ai/pragmatic-component'
import {
    AppliedConfiguration, AppliedConfigurationCodec, AppliedConfigurationEntries, AppliedConfigurationKeys, AppliedDocumentCarryOver, ConfigurationHeadMovedError,
    ConfigurationPreparationRefusal, ConfigurationPreparationStatus, ConfigurationSaveRequest, ConfigurationScope, type ApplyTarget, type ConfigurationVersion,
    type IAppliedConfigMap, type IConfigurationRepository,
} from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeResourceCatalog, type KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import {
    ConfigurationPreparationOutcome, ConfigurationTarget, type ConfigurationPreparationDto, type ConfigurationRunsDto, type IComponentDescriptorSource,
    type IConfigurationPreparationSource, type IConfigurationTargetSource,
} from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ComponentVersionOrder } from './component-version-order.js'
import { ConfigMapWriteLock } from './config-map-write-lock.js'
import { ConsoleSelfApply } from './console-self-apply.js'
import { KubeConfigurationApplier } from './kube-configuration-applier.js'

/** What preparing one target came to. */
export enum PreparationResult
{
    /** An entry validated for the release's descriptor is beside the applied one (written now or found). */
    Prepared = 'prepared',
    /** The applied document does not validate against the release's descriptor; recorded, nothing written. */
    Refused = 'refused',
    /** The applied configuration was validated for the release's descriptor already. */
    Current = 'current',
    /** The applied configuration is for a later component version than the release the console runs: not prepared back. */
    Ahead = 'ahead',
    /** No configuration is applied there: the component starts from its environment, nothing to prepare. */
    Unconfigured = 'unconfigured',
    /** Not this console's to prepare (another realm or component), or not readable as an applied configuration. */
    Skipped = 'skipped',
    /** The cluster or the repository refused; tried again at the next start or apply. */
    Failed = 'failed',
}

/** One target's preparation, by setting names only. */
export class PreparationReport
{
    public readonly Settings: readonly string[]

    public constructor(public readonly Component: string, public readonly Target: ConfigurationTarget, public readonly Result: PreparationResult, settings: readonly string[] = [])
    {
        this.Settings = Object.freeze([...settings])
        Object.freeze(this)
    }
}

/** After an apply or a revert, the target is prepared again from the file now applied (KubeConfigurationApplier). */
export interface IApplyPreparation
{
    PrepareApplied(applied: AppliedConfiguration, target: ApplyTarget): Promise<PreparationReport | undefined>
}

type ConfigMapShape = { metadata?: { name?: unknown; namespace?: unknown; resourceVersion?: unknown; labels?: Record<string, unknown>; annotations?: Record<string, unknown> }; data?: Record<string, unknown> }

/**
 * Prepares every applied configuration for the descriptors of the release this console runs (R2, R5): at start, and
 * again after every apply or revert, for each component it configures and each target of it, the document applied there
 * (`configuration.json` of `pragmatic-config-<component>`) is re-validated against the release's descriptor of that
 * component, when that release's component version is later than the one the document was validated for.
 *
 * The document re-validated is the version the repository holds for the applied version number, as authored, when it is
 * the content applied there (its applied form hashes the same, or the target's last apply was that version); otherwise
 * the applied document itself (a configuration applied by hand), adopted, with the defaults the descriptor it was
 * validated for filled in left behind when that descriptor is known (AppliedDocumentCarryOver).
 *
 * - It validates: it is saved as the scope's next version (unless the head already is that document for that
 *   descriptor) and its applied form is written beside the applied file as the prepared entry
 *   `configuration.json.sha256-<hex>`, marked prepared. The applied file, its hash annotation and the Deployment are not
 *   touched, so nothing rolls: the running pods keep their file and the release's pods read their entry.
 * - It does not: the refusal (the settings that must change and the rules they break, never a value) is recorded, no
 *   entry is written and nothing saved.
 *
 * The status names the applied file it was derived from (`pragmatic-tech.ai/prepared-from`), so an apply since makes it
 * stale until this runs again; entries for descriptors that are neither the release's nor the one the target runs are
 * dropped. Whoever rolls a component onto the release (the platform's installer) reads the status and waits; it never
 * writes a configuration (configuration stays tenant-owned). Writes go under the configuration field manager, serialized
 * with the applier's (ConfigMapWriteLock) and conditioned on the resourceVersion read, and carry only the members the
 * console owns. One target failing never stops the others.
 */
export class ConfigurationPreparer implements IConfigurationPreparationSource, IApplyPreparation
{
    /** The author of a version the console saves itself when preparing (a realm subject cannot be named here). */
    public static readonly Author = 'pragmatic-tenant-admin'
    private static readonly ConfigMapType = { apiVersion: 'v1', kind: 'ConfigMap' }
    private static readonly OptionsPointer = '/options/'
    private static readonly PointerSeparator = '/'
    private static readonly EscapedSlash = /~1/g
    private static readonly EscapedTilde = /~0/g
    private static readonly Slash = '/'
    private static readonly Tilde = '~'
    private static readonly SettingSeparator = '.'
    private static readonly DocumentName = '(document)'
    private static readonly NoText = ''
    private static readonly ErrorSeparator = '; '
    private static readonly CommentPrefix = 'Prepared for '
    private static readonly CommentFrom = ' from applied version '
    private static readonly CommentOpen = ' ('
    private static readonly CommentClose = ')'
    private static readonly LogPrefix = '[configuration] '
    private static readonly LogOn = ' on '
    private static readonly LogPrepared = ': prepared for '
    private static readonly LogAsVersion = ' as version '
    private static readonly LogRefused = ': refused for '
    private static readonly LogChange = ', change '
    private static readonly LogFailed = ': preparing failed: '
    private static readonly LogUnordered = ': not prepared, the versions do not compare: '
    private static readonly LogAnd = ' and '
    private static readonly Space = ' '
    private static readonly SettingsSeparator = ', '
    private static readonly SaveAttempts = 2
    /** The members of the object the console writes (the applier's set): nothing another writer put there is taken over. */
    private static readonly OwnedData: readonly string[] = [AppliedConfigurationKeys.FileName, ConsoleSelfApply.PreviousKey, ConsoleSelfApply.PreviousAnnotationsKey]
    private static readonly OwnedAnnotations: readonly string[] = [
        AppliedConfigurationKeys.VersionAnnotation, AppliedConfigurationKeys.DigestAnnotation, AppliedConfigurationKeys.HashAnnotation, AppliedConfigurationKeys.RealmAnnotation,
        AppliedConfigurationKeys.PreparedDigestsAnnotation, AppliedConfigurationKeys.PreparationRefusedAnnotation, AppliedConfigurationKeys.PreparedFromAnnotation,
        ConsoleSelfApply.PreviousHashAnnotation,
    ]
    private static readonly OwnedLabels: readonly string[] = [AppliedConfigurationKeys.ComponentLabel, AppliedConfigurationKeys.ManagedByLabel]

    public constructor(
        private readonly client: KubeApiClient,
        private readonly repository: IConfigurationRepository,
        private readonly descriptors: IComponentDescriptorSource,
        private readonly targets: IConfigurationTargetSource,
        private readonly lock: ConfigMapWriteLock = new ConfigMapWriteLock(),
        private readonly log: (line: string) => void = () => undefined,
    )
    {
    }

    /** Prepares every target of every component the console configures. Never throws for one target. */
    public async PrepareAll(tenantId: string): Promise<readonly PreparationReport[]>
    {
        const out: PreparationReport[] = []
        for (const component of this.descriptors.Names())
        {
            const descriptor = this.descriptors.Current(component)
            if (descriptor === undefined) continue
            let targets: readonly ConfigurationTarget[]
            try
            {
                targets = await this.targets.For(component, tenantId)
            }
            catch (error)
            {
                this.Log(component, undefined, ConfigurationPreparer.LogFailed + ConfigurationPreparer.NameOf(error))
                continue
            }
            for (const target of targets)
            {
                out.push(await this.PrepareOne(tenantId, component, descriptor, target))
            }
        }
        return out
    }

    /** Prepares one target again from the file just applied (or put back) there. */
    public async PrepareApplied(applied: AppliedConfiguration, target: ApplyTarget): Promise<PreparationReport | undefined>
    {
        const descriptor = this.descriptors.Current(applied.Component)
        if (descriptor === undefined) return undefined
        return await this.PrepareOne(applied.Realm, applied.Component, descriptor, new ConfigurationTarget(target.Namespace, target, undefined, undefined))
    }

    /** What is recorded for `component` at each of `targets` for the file applied there now: one row per prepared or
     *  refused descriptor, except the one the target already runs. */
    public async For(component: string, targets: readonly ConfigurationTarget[]): Promise<readonly ConfigurationPreparationDto[]>
    {
        const P = ConfigurationPreparer
        const out: ConfigurationPreparationDto[] = []
        for (const target of targets)
        {
            let map: ConfigMapShape | undefined
            try
            {
                map = await this.client.Get(P.PathOf(component, target)) as ConfigMapShape | undefined
            }
            catch
            {
                continue
            }
            if (map === undefined) continue
            const status = ConfigurationPreparationStatus.Of(map.metadata?.annotations)
            if (!status.Holds(P.HashOf(map))) continue
            const entries = P.EntriesOf(map)
            for (const digest of status.Prepared.filter(d => d !== target.DescriptorDigest))
            {
                out.push({ environment: target.Name, componentVersion: entries.get(digest)?.ComponentVersion ?? P.NoText, descriptorDigest: digest, outcome: ConfigurationPreparationOutcome.Prepared, settings: [], reason: P.NoText })
            }
            for (const refusal of status.Refusals.filter(r => r.DescriptorDigest !== target.DescriptorDigest))
            {
                out.push({ environment: target.Name, componentVersion: refusal.ComponentVersion, descriptorDigest: refusal.DescriptorDigest, outcome: ConfigurationPreparationOutcome.Refused, settings: [...refusal.Settings], reason: refusal.Reason })
            }
        }
        return out
    }

    /** The prepared entry `target`'s pods run: its running descriptor has one, and the applied file is for another (the
     *  release rolled it onto its entry). Undefined when what it runs is not known, it runs the applied file, or nothing. */
    public async Runs(component: string, target: ConfigurationTarget): Promise<ConfigurationRunsDto | undefined>
    {
        const P = ConfigurationPreparer
        const digest = target.DescriptorDigest
        if (digest === undefined) return undefined
        let map: ConfigMapShape | undefined
        let applied: AppliedConfiguration
        try
        {
            map = await this.client.Get(P.PathOf(component, target)) as ConfigMapShape | undefined
            if (typeof map?.data?.[AppliedConfigurationKeys.FileName] !== 'string') return undefined
            applied = AppliedConfigurationCodec.FromConfigMap(map)
        }
        catch
        {
            return undefined
        }
        if (applied.DescriptorDigest === digest) return undefined
        const entry = P.EntriesOf(map).get(digest)
        return entry === undefined ? undefined : { version: entry.Version, componentVersion: entry.ComponentVersion, appliedVersion: applied.Version }
    }

    private async PrepareOne(tenantId: string, component: string, descriptor: ComponentDescriptor, target: ConfigurationTarget): Promise<PreparationReport>
    {
        const path = ConfigurationPreparer.PathOf(component, target)
        try
        {
            return await this.lock.Run(path, () => this.Prepare(tenantId, component, descriptor, target, path))
        }
        catch (error)
        {
            this.Log(component, target, ConfigurationPreparer.LogFailed + ConfigurationPreparer.NameOf(error))
            return new PreparationReport(component, target, PreparationResult.Failed)
        }
    }

    private async Prepare(tenantId: string, component: string, descriptor: ComponentDescriptor, target: ConfigurationTarget, path: string): Promise<PreparationReport>
    {
        const P = ConfigurationPreparer
        const map = await this.client.Get(path) as ConfigMapShape | undefined
        if (typeof map?.data?.[AppliedConfigurationKeys.FileName] !== 'string') return new PreparationReport(component, target, PreparationResult.Unconfigured)
        let applied: AppliedConfiguration
        try
        {
            applied = AppliedConfigurationCodec.FromConfigMap(map)
        }
        catch
        {
            return new PreparationReport(component, target, PreparationResult.Skipped)
        }
        if (applied.Realm !== tenantId || applied.Component !== component) return new PreparationReport(component, target, PreparationResult.Skipped)
        const digest = descriptor.ContentDigest()
        if (applied.DescriptorDigest === digest) return new PreparationReport(component, target, PreparationResult.Current)
        if (ComponentVersionOrder.Compare(descriptor.Version, applied.ComponentVersion) === undefined)
        {
            this.Log(component, target, P.LogUnordered + applied.ComponentVersion + P.LogAnd + descriptor.Version)
            return new PreparationReport(component, target, PreparationResult.Ahead)
        }
        if (!ComponentVersionOrder.IsNewer(descriptor.Version, applied.ComponentVersion)) return new PreparationReport(component, target, PreparationResult.Ahead)
        const entries = P.EntriesOf(map)
        // What was prepared from another applied file is stale; entries for descriptors nobody runs or rolls to go.
        const status = ConfigurationPreparationStatus.Of(map.metadata?.annotations).DerivedFrom(applied.ContentHash())
        // Only when what the target runs is known: an entry its pods may run from is never dropped on a guess.
        const obsolete = target.DescriptorDigest === undefined ? [] : [...entries.keys()].filter(d => d !== digest && d !== target.DescriptorDigest)
        const base = AppliedConfigurationEntries.Without(P.Writable(map, component, target, status, applied), obsolete)
        const existing = entries.get(digest)
        if (status.IsPrepared(digest) && existing !== undefined && existing.Realm === applied.Realm && existing.Component === component && new ConfigurationValidator(descriptor).Validate(existing.Document).Valid)
        {
            if (obsolete.length > 0) await this.Write(path, base)
            return new PreparationReport(component, target, PreparationResult.Prepared)
        }
        const recorded = status.RefusalFor(digest)
        if (recorded !== undefined && obsolete.length === 0) return new PreparationReport(component, target, PreparationResult.Refused, recorded.Settings)
        const scope = new ConfigurationScope(tenantId, component)
        const source = await this.SourceOf(scope, applied, descriptor, target)
        const validation = new ConfigurationValidator(descriptor).Validate(source)
        if (!validation.Valid)
        {
            const settings = P.SettingsOf(validation.Errors)
            const refusal = new ConfigurationPreparationRefusal(digest, descriptor.Version, settings, validation.Errors.map(e => e.toString()).join(P.ErrorSeparator))
            const refused = AppliedConfigurationEntries.Without(base, [digest])
            refused.metadata.annotations = ConfigurationPreparationStatus.Of(refused.metadata.annotations).WithRefusal(refusal).Over(refused.metadata.annotations)
            await this.Write(path, refused)
            this.Log(component, target, P.LogRefused + descriptor.Version + P.LogChange + settings.join(P.SettingsSeparator))
            return new PreparationReport(component, target, PreparationResult.Refused, settings)
        }
        const saved = await this.SaveFor(scope, source, descriptor, applied)
        await this.Write(path, AppliedConfigurationEntries.With(base, AppliedConfiguration.From(saved, descriptor)))
        this.Log(component, target, P.LogPrepared + descriptor.Version + P.LogAsVersion + String(saved.Number))
        return new PreparationReport(component, target, PreparationResult.Prepared)
    }

    // The applied version as authored when the repository holds that content; else the applied document, its inherited
    // defaults left behind when the descriptor it was validated for is known.
    private async SourceOf(scope: ConfigurationScope, applied: AppliedConfiguration, descriptor: ComponentDescriptor, target: ConfigurationTarget): Promise<unknown>
    {
        const inherited = await this.InheritedOf(applied)
        const held = await this.repository.Version(scope, applied.Version)
        if (held !== null && held.DescriptorDigest === applied.DescriptorDigest && await this.Holds(held, applied, inherited, scope, target)) return held.Document
        return inherited === undefined ? applied.Document : AppliedDocumentCarryOver.Carry(applied.Document, descriptor, inherited).Document
    }

    // Whether the repository's version is what is applied: its applied form hashes the same (descriptor known), or the
    // target's last successful apply was that version.
    private async Holds(held: ConfigurationVersion, applied: AppliedConfiguration, inherited: ComponentDescriptor | undefined, scope: ConfigurationScope, target: ConfigurationTarget): Promise<boolean>
    {
        if (inherited !== undefined)
        {
            try
            {
                return AppliedConfiguration.From(held, inherited).ContentHash() === applied.ContentHash()
            }
            catch
            {
                return false
            }
        }
        return (await this.repository.Applied(scope, target.Target))?.Version === applied.Version
    }

    // The descriptor the applied file was validated for, when the console can read it (its release, or an adopted one).
    private async InheritedOf(applied: AppliedConfiguration): Promise<ComponentDescriptor | undefined>
    {
        try
        {
            const descriptor = await this.descriptors.For(applied.Component, applied.ComponentVersion)
            return descriptor !== undefined && descriptor.ContentDigest() === applied.DescriptorDigest ? descriptor : undefined
        }
        catch
        {
            return undefined
        }
    }

    // The head when it already is this document for this descriptor (a start that saved but could not write), else a new version.
    private async SaveFor(scope: ConfigurationScope, document: unknown, descriptor: ComponentDescriptor, applied: AppliedConfiguration): Promise<ConfigurationVersion>
    {
        const P = ConfigurationPreparer
        const comment = P.CommentPrefix + descriptor.Version + P.CommentFrom + String(applied.Version) + P.CommentOpen + applied.ComponentVersion + P.CommentClose
        for (let attempt = 1; ; attempt += 1)
        {
            const head = await this.repository.Head(scope)
            if (head !== null && head.DescriptorDigest === descriptor.ContentDigest() && CanonicalJson.Stringify(head.Document) === CanonicalJson.Stringify(document)) return head
            try
            {
                return await this.repository.Save(new ConfigurationSaveRequest(scope, head === null ? 0 : head.Number, document, descriptor, P.Author, comment))
            }
            catch (error)
            {
                if (!(error instanceof ConfigurationHeadMovedError) || attempt >= P.SaveAttempts) throw error
            }
        }
    }

    private async Write(path: string, map: IAppliedConfigMap): Promise<void>
    {
        await this.client.Apply(path, map, KubeConfigurationApplier.FieldManager)
    }

    private Log(component: string, target: ConfigurationTarget | undefined, text: string): void
    {
        const P = ConfigurationPreparer
        this.log(P.LogPrefix + component + (target === undefined ? P.NoText : P.LogOn + target.Name) + text)
    }

    private static PathOf(component: string, target: ConfigurationTarget): string
    {
        return KubeResourceCatalog.PathOf(ConfigurationPreparer.ConfigMapType, target.Target.Namespace, AppliedConfigurationKeys.ObjectNamePrefix + component)
    }

    private static HashOf(map: ConfigMapShape): string | undefined
    {
        const hash = map.metadata?.annotations?.[AppliedConfigurationKeys.HashAnnotation]
        return typeof hash === 'string' ? hash : undefined
    }

    // The object as this console writes it back: only the members it owns (the applier's set and the entries), the status
    // given, and the resourceVersion read, so a write over a change made since is refused (409).
    private static Writable(map: ConfigMapShape, component: string, target: ConfigurationTarget, status: ConfigurationPreparationStatus, applied: AppliedConfiguration): IAppliedConfigMap
    {
        const P = ConfigurationPreparer
        const data = P.Owned(map.data, key => P.OwnedData.includes(key) || AppliedConfigurationEntries.DigestOfKey(key) !== undefined)
        // A hand-applied object may lack the hash the status is checked against: it is the applied file's own (the pod
        // template's annotation, which rolls, is not touched).
        const owned = { [AppliedConfigurationKeys.HashAnnotation]: applied.ContentHash(), ...P.Owned(map.metadata?.annotations, key => P.OwnedAnnotations.includes(key)) }
        const annotations = status.Over(owned)
        const labels = P.Owned(map.metadata?.labels, key => P.OwnedLabels.includes(key))
        const metadata: IAppliedConfigMap['metadata'] & { resourceVersion?: string } = { name: AppliedConfigurationKeys.ObjectNamePrefix + component, namespace: target.Target.Namespace, labels, annotations }
        if (typeof map.metadata?.resourceVersion === 'string') metadata.resourceVersion = map.metadata.resourceVersion
        return { apiVersion: P.ConfigMapType.apiVersion, kind: P.ConfigMapType.kind, metadata, data }
    }

    private static Owned(values: Record<string, unknown> | undefined, owned: (key: string) => boolean): Record<string, string>
    {
        const out: Record<string, string> = {}
        for (const [key, value] of Object.entries(values ?? {}))
        {
            if (owned(key) && typeof value === 'string') out[key] = value
        }
        return out
    }

    // Entries that do not read count as none: preparing writes a fresh one.
    private static EntriesOf(map: ConfigMapShape): ReadonlyMap<string, AppliedConfiguration>
    {
        try
        {
            return AppliedConfigurationEntries.Prepared(map)
        }
        catch
        {
            return new Map()
        }
    }

    // `/options/core/databaseUrl` → `core.databaseUrl`; `/options/core` → `core`; the document itself by a fixed name.
    private static SettingsOf(errors: readonly ConfigurationError[]): string[]
    {
        const P = ConfigurationPreparer
        const names = errors.map(e =>
        {
            if (e.Path === P.NoText) return P.DocumentName
            if (!e.Path.startsWith(P.OptionsPointer)) return e.Path
            return e.Path.slice(P.OptionsPointer.length).split(P.PointerSeparator).map(s => s.replace(P.EscapedSlash, P.Slash).replace(P.EscapedTilde, P.Tilde)).join(P.SettingSeparator)
        })
        return [...new Set(names)]
    }

    private static NameOf(error: unknown): string
    {
        return error instanceof Error ? error.name + ConfigurationPreparer.Space + error.message : String(error)
    }
}
