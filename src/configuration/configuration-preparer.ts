import { CanonicalJson, ConfigurationValidator, type ComponentDescriptor, type ConfigurationError } from '@pragmatic-tech-ai/pragmatic-component'
import {
    AppliedConfiguration, AppliedConfigurationCodec, AppliedConfigurationEntries, AppliedConfigurationKeys, ConfigurationHeadMovedError, ConfigurationPreparationRefusal,
    ConfigurationPreparationStatus, ConfigurationSaveRequest, ConfigurationScope, type ConfigurationVersion, type IAppliedConfigMap, type IConfigurationRepository,
} from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeResourceCatalog, type KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import {
    ConfigurationPreparationOutcome, type ConfigurationPreparationDto, type ConfigurationTarget, type IComponentDescriptorSource, type IConfigurationPreparationSource,
    type IConfigurationTargetSource,
} from '@pragmatic-tech-ai/pragmatic-tenant-plane'
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
    /** No configuration is applied there: the component starts from its environment, nothing to prepare. */
    Unconfigured = 'unconfigured',
    /** Not this console's to prepare (another realm), or not readable as an applied configuration. */
    Skipped = 'skipped',
    /** The cluster or the repository refused; tried again at the next start. */
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

type ConfigMapShape = { metadata?: { name?: unknown; namespace?: unknown; labels?: Record<string, unknown>; annotations?: Record<string, unknown> }; data?: Record<string, unknown> }

/**
 * Prepares every applied configuration for the descriptors of the release this console runs (R2, R5): at start, for each
 * component it configures and each target of it, the document applied there (`configuration.json` of
 * `pragmatic-config-<component>`) is re-validated against the release's descriptor of that component. The document
 * re-validated is the one the repository holds for the applied version (as authored), or, when the repository does not
 * hold it (a configuration applied by hand), the applied document itself, which is then adopted.
 *
 * - It validates: it is saved as the scope's next version, validated for the new descriptor (unless the head already is
 *   that document for that descriptor), and its applied form is written beside the applied file as the prepared entry
 *   `configuration.json.sha256-<hex>`, marked prepared (`pragmatic-tech.ai/prepared-digests`). The applied file, the
 *   ConfigMap's hash annotation and the Deployment are not touched, so nothing rolls: the running pods keep their file
 *   and the new release's pods read their entry.
 * - It does not: the refusal (the settings that must change, the rules they break, never a value) is recorded on the
 *   ConfigMap (`pragmatic-tech.ai/preparation-refused`), nothing is saved and no entry written.
 *
 * Whoever rolls a component onto the new release (the platform's installer) reads that status and waits; it never writes
 * a configuration (configuration stays tenant-owned). Writes go under the configuration field manager, so a later apply
 * keeps what was prepared (KubeConfigurationApplier). One target failing never stops the others.
 */
export class ConfigurationPreparer implements IConfigurationPreparationSource
{
    /** The author of a version the console saves itself when preparing (a realm subject cannot be named here). */
    public static readonly Author = 'pragmatic-tenant-admin'
    private static readonly ConfigMapType = { apiVersion: 'v1', kind: 'ConfigMap' }
    private static readonly LastApplied = 'kubectl.kubernetes.io/last-applied-configuration'
    private static readonly OptionsPointer = '/options/'
    private static readonly PointerSeparator = '/'
    private static readonly SettingSeparator = '.'
    private static readonly DocumentName = '(document)'
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
    private static readonly Space = ' '
    private static readonly SettingsSeparator = ', '
    private static readonly SaveAttempts = 2

    public constructor(
        private readonly client: KubeApiClient,
        private readonly repository: IConfigurationRepository,
        private readonly descriptors: IComponentDescriptorSource,
        private readonly targets: IConfigurationTargetSource,
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

    /** What was recorded for `component` at each of `targets`: one row per prepared or refused descriptor. */
    public async For(component: string, targets: readonly ConfigurationTarget[]): Promise<readonly ConfigurationPreparationDto[]>
    {
        const out: ConfigurationPreparationDto[] = []
        for (const target of targets)
        {
            let map: ConfigMapShape | undefined
            try
            {
                map = await this.client.Get(ConfigurationPreparer.PathOf(component, target)) as ConfigMapShape | undefined
            }
            catch
            {
                continue
            }
            if (map === undefined) continue
            const status = ConfigurationPreparationStatus.Of(map.metadata?.annotations)
            const entries = ConfigurationPreparer.EntriesOf(map)
            for (const digest of status.Prepared)
            {
                out.push({ environment: target.Name, componentVersion: entries.get(digest)?.ComponentVersion ?? '', descriptorDigest: digest, outcome: ConfigurationPreparationOutcome.Prepared, settings: [], reason: '' })
            }
            for (const refusal of status.Refusals)
            {
                out.push({ environment: target.Name, componentVersion: refusal.ComponentVersion, descriptorDigest: refusal.DescriptorDigest, outcome: ConfigurationPreparationOutcome.Refused, settings: [...refusal.Settings], reason: refusal.Reason })
            }
        }
        return out
    }

    private async PrepareOne(tenantId: string, component: string, descriptor: ComponentDescriptor, target: ConfigurationTarget): Promise<PreparationReport>
    {
        try
        {
            return await this.Prepare(tenantId, component, descriptor, target)
        }
        catch (error)
        {
            this.Log(component, target, ConfigurationPreparer.LogFailed + ConfigurationPreparer.NameOf(error))
            return new PreparationReport(component, target, PreparationResult.Failed)
        }
    }

    private async Prepare(tenantId: string, component: string, descriptor: ComponentDescriptor, target: ConfigurationTarget): Promise<PreparationReport>
    {
        const P = ConfigurationPreparer
        const path = P.PathOf(component, target)
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
        const writable = P.Writable(map, component, target)
        const status = ConfigurationPreparationStatus.Of(writable.metadata.annotations)
        const existing = P.EntriesOf(map).get(digest)
        if (existing !== undefined && existing.Realm === applied.Realm && new ConfigurationValidator(descriptor).Validate(existing.Document).Valid)
        {
            if (!status.IsPrepared(digest)) await this.Write(path, AppliedConfigurationEntries.With(writable, existing))
            return new PreparationReport(component, target, PreparationResult.Prepared)
        }
        const scope = new ConfigurationScope(tenantId, component)
        const source = await this.SourceOf(scope, applied)
        const validation = new ConfigurationValidator(descriptor).Validate(source)
        if (!validation.Valid)
        {
            const settings = P.SettingsOf(validation.Errors)
            const refusal = new ConfigurationPreparationRefusal(digest, descriptor.Version, settings, validation.Errors.map(e => e.toString()).join(P.ErrorSeparator))
            const refused = AppliedConfigurationEntries.Without(writable, [digest])
            refused.metadata.annotations = ConfigurationPreparationStatus.Of(refused.metadata.annotations).WithRefusal(refusal).Over(refused.metadata.annotations)
            await this.Write(path, refused)
            this.Log(component, target, P.LogRefused + descriptor.Version + P.LogChange + settings.join(P.SettingsSeparator))
            return new PreparationReport(component, target, PreparationResult.Refused, settings)
        }
        const saved = await this.SaveFor(scope, source, descriptor, applied)
        const entry = AppliedConfiguration.From(saved, descriptor)
        await this.Write(path, AppliedConfigurationEntries.With(writable, entry))
        this.Log(component, target, P.LogPrepared + descriptor.Version + P.LogAsVersion + String(saved.Number))
        return new PreparationReport(component, target, PreparationResult.Prepared)
    }

    // The applied version as authored when the repository holds it (same number, same descriptor), else the applied document.
    private async SourceOf(scope: ConfigurationScope, applied: AppliedConfiguration): Promise<unknown>
    {
        const held = await this.repository.Version(scope, applied.Version)
        return held !== null && held.DescriptorDigest === applied.DescriptorDigest ? held.Document : applied.Document
    }

    // The head when it already is this document for this descriptor (a start that saved but could not write), else a new version.
    private async SaveFor(scope: ConfigurationScope, document: unknown, descriptor: ComponentDescriptor, applied: AppliedConfiguration): Promise<ConfigurationVersion>
    {
        const P = ConfigurationPreparer
        const comment = P.CommentPrefix + descriptor.Version + P.CommentFrom + String(applied.Version) + P.CommentOpen + applied.ComponentVersion + P.CommentClose
        for (let attempt = 1; ; attempt += 1)
        {
            const head = await this.repository.Head(scope)
            if (head !== null && head.DescriptorDigest === descriptor.ContentDigest() && CanonicalJson.Stringify(head.Document) === CanonicalJson.Stringify(document as never)) return head
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
        this.log(P.LogPrefix + component + (target === undefined ? '' : P.LogOn + target.Name) + text)
    }

    private static PathOf(component: string, target: ConfigurationTarget): string
    {
        return KubeResourceCatalog.PathOf(ConfigurationPreparer.ConfigMapType, target.Target.Namespace, AppliedConfigurationKeys.ObjectNamePrefix + component)
    }

    // The object as this console writes it back: identity, labels, annotations (kubectl's record left to kubectl) and data.
    private static Writable(map: ConfigMapShape, component: string, target: ConfigurationTarget): IAppliedConfigMap
    {
        const P = ConfigurationPreparer
        const annotations: Record<string, string> = {}
        for (const [key, value] of Object.entries(map.metadata?.annotations ?? {}))
        {
            if (key !== P.LastApplied && typeof value === 'string') annotations[key] = value
        }
        const labels: Record<string, string> = {}
        for (const [key, value] of Object.entries(map.metadata?.labels ?? {}))
        {
            if (typeof value === 'string') labels[key] = value
        }
        const data: Record<string, string> = {}
        for (const [key, value] of Object.entries(map.data ?? {}))
        {
            if (typeof value === 'string') data[key] = value
        }
        return {
            apiVersion: P.ConfigMapType.apiVersion,
            kind: P.ConfigMapType.kind,
            metadata: { name: AppliedConfigurationKeys.ObjectNamePrefix + component, namespace: target.Target.Namespace, labels, annotations },
            data,
        }
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
        const names = errors.map(e => e.Path.startsWith(P.OptionsPointer) ? e.Path.slice(P.OptionsPointer.length).split(P.PointerSeparator).join(P.SettingSeparator) : e.Path === '' ? P.DocumentName : e.Path)
        return [...new Set(names)]
    }

    private static NameOf(error: unknown): string
    {
        return error instanceof Error ? error.name + ConfigurationPreparer.Space + error.message : String(error)
    }
}
