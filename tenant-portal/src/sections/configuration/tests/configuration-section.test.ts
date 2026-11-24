import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { ApiError } from '../../../tenant-api-client.js'
import { ConfigurationApplyDetails, ConfigurationApplyOutcome, ConfigurationChangeKind, ConfigurationPreparationOutcome } from '../../../tenant-types.js'
import { PageState } from '../../../shell/tenant-page-view-model.js'
import { FakeTenantApi, TenantTestHost, TestRail, Tick } from '../../../shell/tests/tenant-test-fixtures.js'
import { ContentHostService } from '@pragmatic-tech-ai/mural/framework/shell/services/content-host-service.js'
import { ConfigurationSectionService } from '../configuration-section-service.js'
import { ConfigurationPageViewModel, type IConfigurationNavigator } from '../configuration-page-view-model.js'
import { ComponentConfigurationPageViewModel } from '../component-configuration-page-view-model.js'
import { ConfigurationEditorViewModel } from '../configuration-editor-view-model.js'
import { ConfigurationSettingRowViewModel, ConfigurationTargetRowViewModel } from '../configuration-rows.js'
import type { IConfigurationApplyWait } from '../configuration-apply-wait.js'
import type { ConfigurationApplyDto } from '../../../tenant-types.js'

// A simulated clock: a delay passes at once and moves Now on; runs `OnWait` (the console coming back, the apply settling)
// before each read that follows a delay. A read's timeout never fires unless `TimeoutsFire` (then it moves Now on too).
class InstantWait implements IConfigurationApplyWait
{
    public Waits = 0
    public Clock = 0
    public TimeoutsFire = false
    public readonly Delays: number[] = []
    public OnWait: (wait: number) => void = () => undefined

    public Now(): number
    {
        return this.Clock
    }

    public async Delay(ms: number): Promise<void>
    {
        this.Waits++
        this.Clock += ms
        this.Delays.push(ms)
        this.OnWait(this.Waits)
    }

    public Timeout(ms: number): Promise<void>
    {
        if (!this.TimeoutsFire) return new Promise<void>(() => undefined)
        this.Clock += ms
        return Promise.resolve()
    }
}

class RecordingNavigator implements IConfigurationNavigator
{
    public readonly Opened: string[] = []
    public Backs = 0
    public readonly BackCommand = new RelayCommand(() => { this.Backs++ })

    public OpenComponent(component: string): void
    {
        this.Opened.push(component)
    }
}

class ConfigFixture
{
    public static readonly Options = [{
        name: 'database', description: 'Where the graph keeps its data.',
        settings: [
            { name: 'url', type: 'string', description: 'The connection URL.', required: true, secret: false },
            { name: 'password', type: 'string', description: 'The database password.', required: true, secret: true },
            { name: 'poolSize', type: 'integer', description: 'Connections kept open.', required: false, secret: false, default: 10 },
        ],
    }]

    public readonly Api: FakeTenantApi
    public readonly Host: TenantTestHost
    public readonly Navigator = new RecordingNavigator()

    public constructor(canEdit: boolean = true)
    {
        this.Api = new FakeTenantApi()
            .WithConfiguration('graph', [{ database: { url: 'postgres://a' } }, { database: { url: 'postgres://b', password: 'secret:vault/graph-db' } }],
                ['production', 'staging'], ConfigFixture.Options)
            .WithConfiguration('relay', [], ['production'])
        this.Host = new TenantTestHost(this.Api, { ...TenantTestHost.AllCapabilities, settings: canEdit })
    }

    // The console's own configuration (two versions, its one target), whose apply restarts the console.
    public static readonly Console = 'pragmatic-tenant-admin'
    public static readonly ConsoleTarget = 'pragmatic-system'

    public async Console(wait: IConfigurationApplyWait): Promise<ComponentConfigurationPageViewModel>
    {
        this.Api.WithConfiguration(ConfigFixture.Console, [{ core: { healthProbeMs: 45000 } }, { core: { healthProbeMs: 30000 } }], [ConfigFixture.ConsoleTarget])
        const page = await this.Component(ConfigFixture.Console, wait)
        page.SelectedTarget = page.TargetOptions.ToArray()[0]
        return page
    }

    // The record the restarted console keeps for its own apply (here written by the test: the request was cut).
    public SettleConsoleApply(outcome: ConfigurationApplyOutcome, detail: string | null = null, id: string = 'apply-self'): ConfigurationApplyDto
    {
        const record: ConfigurationApplyDto = {
            id, version: 2, environment: ConfigFixture.ConsoleTarget, outcome, requestedBy: 'owner@example.test',
            requestedAt: '2026-11-24T08:53:58.000Z', completedAt: outcome === ConfigurationApplyOutcome.Pending ? null : '2026-11-24T08:54:50.000Z', detail,
        }
        const applies = this.Api.ConfigurationApplies.get(ConfigFixture.Console)!
        const at = applies.findIndex(a => a.id === id)
        if (at >= 0) applies.splice(at, 1, record)
        else applies.unshift(record)
        return record
    }

    public async List(): Promise<ConfigurationPageViewModel>
    {
        const page = new ConfigurationPageViewModel(this.Host.Session, this.Navigator)
        await page.Refresh()
        return page
    }

    public async Component(component: string = 'graph', wait?: IConfigurationApplyWait): Promise<ComponentConfigurationPageViewModel>
    {
        const page = new ComponentConfigurationPageViewModel(this.Host.Session, this.Navigator, component, wait)
        await page.Refresh()
        return page
    }
}

describe('ConfigurationPageViewModel', () =>
{
    it('lists each component with its head and what is applied on each target', async () =>
    {
        const fx = new ConfigFixture()
        fx.Api.ConfigurationTargets.get('graph')![0]!.applied = 2
        const page = await fx.List()
        assert.equal(page.State, PageState.Populated)
        const rows = page.Rows.ToArray()
        assert.deepEqual(rows.map(r => [r.Component, r.HeadText, r.TargetsText]), [
            ['graph', 'Version 2', 'production: version 2 applied; staging: nothing applied'],
            ['relay', 'No versions yet', 'production: nothing applied'],
        ])
        rows[1]!.OpenCommand.Execute()
        assert.deepEqual(fx.Navigator.Opened, ['relay'])
    })

    it('is Empty when the console runs no configurable component, Denied on 403', async () =>
    {
        const empty = new ConfigurationPageViewModel(new TenantTestHost(new FakeTenantApi()).Session, new RecordingNavigator())
        await empty.Refresh()
        assert.equal(empty.State, PageState.Empty)
        const api = new FakeTenantApi()
        api.FailOn.set('ListConfigurationComponents', new ApiError(403, 'forbidden'))
        const denied = new ConfigurationPageViewModel(new TenantTestHost(api).Session, new RecordingNavigator())
        await denied.Refresh()
        assert.equal(denied.State, PageState.Denied)
    })
})

describe('ComponentConfigurationPageViewModel', () =>
{
    it('shows the settings (secret ones as references), the versions newest first, the targets and the applies', async () =>
    {
        const fx = new ConfigFixture()
        const page = await fx.Component()
        assert.equal(page.State, PageState.Populated)
        assert.equal(page.Title, 'graph')
        assert.deepEqual(page.SettingRows.ToArray().map(r => [r.Path, r.TypeText, r.RequiredText, r.DefaultText]), [
            ['database.url', 'string', 'Required', ''],
            ['database.password', 'secret reference', 'Required', ''],
            ['database.poolSize', 'integer', 'Optional', 'Default 10'],
        ])
        assert.deepEqual(page.VersionRows.ToArray().map(r => [r.VersionText, r.IsHead]), [['Version 2', true], ['Version 1', false]])
        assert.deepEqual(page.TargetRows.ToArray().map(r => [r.Environment, r.AppliedText]), [['production', 'Nothing applied'], ['staging', 'Nothing applied']])
        assert.equal(page.HasApplies, false)
    })

    it('shows the range a bounded integer setting accepts beside its type', () =>
    {
        const option = { name: 'core', description: '', settings: [] }
        const row = (bounds: { minimum?: number; maximum?: number }) => new ConfigurationSettingRowViewModel(option, { name: 'drainTimeoutMs', type: 'integer', description: '', required: false, secret: false, ...bounds }).TypeText
        assert.deepEqual([row({ minimum: 1, maximum: 25000 }), row({ minimum: 1000 }), row({ maximum: 25000 }), row({})],
            ['integer, 1 to 25000', 'integer, at least 1000', 'integer, at most 25000', 'integer'])
    })

    it("views one version's document as indented JSON", async () =>
    {
        const fx = new ConfigFixture()
        const page = await fx.Component()
        page.VersionRows.ToArray()[1]!.ViewCommand.Execute()
        await Tick.Settle()
        assert.equal(page.ViewedTitle, 'Version 1')
        assert.equal(page.ViewedDocumentText, JSON.stringify({ database: { url: 'postgres://a' } }, null, 2))
        assert.equal(page.HasViewed, true)
    })

    it('diffs two versions, from the empty document (0) by default', async () =>
    {
        const fx = new ConfigFixture()
        fx.Api.ConfigurationDiff = { from: 0, to: 0, changes: [
            { path: 'database.url', kind: ConfigurationChangeKind.Changed, before: 'postgres://a', after: 'postgres://b' },
            { path: 'database.password', kind: ConfigurationChangeKind.Added, after: 'secret:vault/graph-db' },
        ] }
        const page = await fx.Component()
        assert.deepEqual(page.FromOptions.ToArray().map(o => o.Label), ['Empty document', 'Version 2', 'Version 1'])
        assert.equal(page.SelectedFrom?.Value, 0)
        assert.equal(page.SelectedTo?.Value, 2)
        page.CompareCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.Calls.find(c => c[0] === 'DiffConfigurationVersions'), ['DiffConfigurationVersions', 'graph', 0, 2])
        assert.deepEqual(page.ChangeRows.ToArray().map(r => [r.Path, r.KindText, r.BeforeText, r.AfterText]), [
            ['database.url', 'Changed', '"postgres://a"', '"postgres://b"'],
            ['database.password', 'Added', '', '"secret:vault/graph-db"'],
        ])
        assert.equal(page.DiffSummaryText, '2 changes from the empty document to version 2.')
        page.SelectedFrom = page.FromOptions.ToArray()[1]
        assert.equal(page.CompareCommand.CanExecute(), false)
    })

    it('starts the editor from the head and saves a new version based on it', async () =>
    {
        const fx = new ConfigFixture()
        const page = await fx.Component()
        const editor = page.Editor
        assert.equal(editor.BasedOn, 2)
        assert.equal(editor.Text, JSON.stringify({ database: { url: 'postgres://b', password: 'secret:vault/graph-db' } }, null, 2))
        assert.equal(page.SaveCommand.CanExecute(), false, 'nothing changed yet')
        editor.Text = '{ "database": { "url": "postgres://c", "password": "secret:vault/graph-db" } }'
        editor.Comment = 'move the database'
        assert.equal(page.SaveCommand.CanExecute(), true)
        page.SaveCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.Calls.find(c => c[0] === 'SaveConfigurationVersion'),
            ['SaveConfigurationVersion', 'graph', 2, { database: { url: 'postgres://c', password: 'secret:vault/graph-db' } }, 'move the database'])
        assert.equal(page.NoticeText, 'Saved version 3.')
        assert.equal(page.Editor.BasedOn, 3)
        assert.equal(page.VersionRows.ToArray()[0]?.VersionText, 'Version 3')
    })

    it('a document that is not a JSON object cannot be saved, and says why', async () =>
    {
        const fx = new ConfigFixture()
        const page = await fx.Component()
        page.Editor.Text = '{ "database": '
        assert.equal(page.SaveCommand.CanExecute(), false)
        assert.equal(page.Editor.ParseErrorText, 'This is not valid JSON yet.')
        page.Editor.Text = '[1, 2]'
        assert.equal(page.Editor.ParseErrorText, 'The document must be a JSON object.')
        page.Editor.Text = '{}'
        assert.equal(page.Editor.ParseErrorText, '')
    })

    it("shows the server's validation errors per path (422) and keeps the edit", async () =>
    {
        const fx = new ConfigFixture()
        const page = await fx.Component()
        fx.Api.FailOn.set('SaveConfigurationVersion', new ApiError(422, 'The document does not validate.', undefined, {
            error: 'The document does not validate.',
            errors: [{ path: 'database.password', message: 'A secret setting takes a secret reference (secret:<store>/<name>), not a value.' }, { path: 'database.url', message: 'Required.' }],
        }))
        page.Editor.Text = '{ "database": { "password": "hunter2" } }'
        page.SaveCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(page.Editor.ErrorRows.ToArray().map(r => [r.Path, r.Message]), [
            ['database.password', 'A secret setting takes a secret reference (secret:<store>/<name>), not a value.'],
            ['database.url', 'Required.'],
        ])
        assert.equal(page.Editor.HasErrors, true)
        assert.equal(page.Editor.Text, '{ "database": { "password": "hunter2" } }')
        assert.equal(page.CommandErrorText, '')
        page.Editor.Text = '{ "database": { "password": "secret:vault/db" } }'
        assert.equal(page.Editor.HasErrors, false, 'an edit clears the stale errors')
    })

    it('says when the head moved meanwhile (409) and reloads the editor on request', async () =>
    {
        const fx = new ConfigFixture()
        const page = await fx.Component()
        fx.Api.ConfigurationDocuments.get('graph')!.push({ database: { url: 'postgres://elsewhere' } })
        page.Editor.Text = '{ "database": { "url": "postgres://mine" } }'
        page.SaveCommand.Execute()
        await Tick.Settle()
        assert.equal(page.Editor.ConflictText, 'Someone saved version 3 while you were editing. Start again from it to keep both changes.')
        page.ReloadEditorCommand.Execute()
        await Tick.Settle()
        assert.equal(page.Editor.BasedOn, 3)
        assert.equal(page.Editor.ConflictText, '')
        assert.equal(page.Editor.Text, JSON.stringify({ database: { url: 'postgres://elsewhere' } }, null, 2))
    })

    it('the first version of a component starts from an empty object', async () =>
    {
        const fx = new ConfigFixture()
        const page = await fx.Component('relay')
        assert.equal(page.Editor.BasedOn, 0)
        assert.equal(page.Editor.Text, '{}')
        assert.equal(page.Editor.BasedOnText, 'The first version.')
    })

    it('applies a version to one of its targets and shows the outcome', async () =>
    {
        const fx = new ConfigFixture()
        const page = await fx.Component()
        assert.deepEqual(page.TargetOptions.ToArray().map(o => o.Label), ['production', 'staging'])
        page.SelectedTarget = page.TargetOptions.ToArray()[1]
        assert.equal(page.SelectedApplyVersion?.Value, 2)
        page.ApplyCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.Calls.find(c => c[0] === 'ApplyConfigurationVersion'), ['ApplyConfigurationVersion', 'graph', 2, 'staging'])
        assert.equal(page.NoticeText, 'Applied version 2 to staging.')
        assert.deepEqual(page.TargetRows.ToArray().map(r => [r.Environment, r.AppliedText]), [['production', 'Nothing applied'], ['staging', 'Version 2 applied']])
        assert.deepEqual(page.ApplyRows.ToArray().map(r => [r.VersionText, r.Environment, r.OutcomeText]), [['Version 2', 'staging', 'Applied']])
    })

    it('a failed apply says so with its detail', async () =>
    {
        const fx = new ConfigFixture()
        fx.Api.ApplyOutcome = ConfigurationApplyOutcome.Failed
        fx.Api.ApplyDetail = 'The deployment did not roll out.'
        const page = await fx.Component()
        page.SelectedTarget = page.TargetOptions.ToArray()[0]
        page.ApplyCommand.Execute()
        await Tick.Settle()
        assert.equal(page.NoticeText, 'Applying version 2 to production failed: The deployment did not roll out.')
    })

    it('shows Reverted for a failed apply whose new pods never became ready', async () =>
    {
        const fx = new ConfigFixture()
        fx.Api.ApplyOutcome = ConfigurationApplyOutcome.Failed
        fx.Api.ApplyDetail = ConfigurationApplyDetails.RolloutNotReady
        const page = await fx.Component()
        page.SelectedTarget = page.TargetOptions.ToArray()[0]
        page.ApplyCommand.Execute()
        await Tick.Settle()
        assert.equal(page.NoticeText, 'Version 2 did not become ready on production: the previous configuration is running again.')
        const [row] = page.ApplyRows.ToArray()
        assert.deepEqual([row.OutcomeText, row.IsReverted, row.IsFailed], ['Reverted', true, true])
        assert.match(row.DetailText, /previous configuration is running again/)
        assert.deepEqual(page.TargetRows.ToArray().map(r => r.AppliedText), ['Nothing applied', 'Nothing applied'])
    })

    it('shows how the configuration was prepared for the release: ready, or the settings to change first', async () =>
    {
        const fx = new ConfigFixture()
        fx.Api.ConfigurationPreparations.set('graph', [
            { environment: 'production', componentVersion: '0.2.4', descriptorDigest: 'sha256:b', outcome: ConfigurationPreparationOutcome.Prepared, settings: [], reason: '' },
            { environment: 'staging', componentVersion: '0.2.4', descriptorDigest: 'sha256:b', outcome: ConfigurationPreparationOutcome.Refused, settings: ['database.poolSize'], reason: '/options/database/poolSize is not a setting of this option' },
        ])
        const page = await fx.Component()
        assert.deepEqual([page.HasReady, page.HasRefused], [true, true])
        assert.equal(page.ReadyText, 'Ready for 0.2.4 on production: a version validated for it is prepared beside the running one.')
        assert.equal(page.RefusedText, 'Not ready for 0.2.4 on staging: change database.poolSize before the platform rolls it out (/options/database/poolSize is not a setting of this option).')
        const plain = await new ConfigFixture().Component()
        assert.deepEqual([plain.HasReady, plain.HasRefused, plain.ReadyText, plain.RefusedText], [false, false, '', ''])
    })

    it('shows the apply in progress and offers no second apply meanwhile', async () =>
    {
        const fx = new ConfigFixture()
        const page = await fx.Component()
        page.SelectedTarget = page.TargetOptions.ToArray()[0]
        page.ApplyCommand.Execute()
        assert.equal(page.IsApplying, true)
        assert.match(page.ApplyingText, /^Applying version 2 to production: waiting up to two minutes for the new pods/)
        assert.equal(page.ApplyCommand.CanExecute(undefined), false)
        await Tick.Settle()
        assert.deepEqual([page.IsApplying, page.ApplyingText], [false, ''])
    })

    it("the console's own apply: the request its restart cuts (502) is expected; the page says the console is restarting, waits for it, then shows the outcome", async () =>
    {
        const fx = new ConfigFixture()
        const wait = new InstantWait()
        const page = await fx.Console(wait)
        fx.Api.FailOn.set('ApplyConfigurationVersion', new ApiError(502, 'Request failed: 502'))
        // The console is gone for two reads (the ingress's 502, then no answer at all), then answers with its apply still
        // being proven, then applied.
        const texts: string[] = []
        wait.OnWait = n =>
        {
            texts.push(page.ApplyingText)
            if (n === 1) fx.Api.FailNext.set('GetConfigurationComponent', [new ApiError(502, 'Request failed: 502'), new TypeError('Failed to fetch')])
            if (n === 3) fx.SettleConsoleApply(ConfigurationApplyOutcome.Pending)
            if (n === 4) fx.SettleConsoleApply(ConfigurationApplyOutcome.Applied)
        }
        page.ApplyCommand.Execute()
        assert.equal(page.IsApplying, true)
        assert.match(page.ApplyingText, /^Applying version 2 to pragmatic-system: the console restarts with it, and this page waits until it answers/)
        for (let i = 0; i < 5 && page.IsApplying; i++) await Tick.Settle()
        assert.equal(texts[0], 'Applying version 2 to pragmatic-system… the console is restarting; this page reconnects when it answers, then shows the outcome.')
        assert.equal(wait.Waits, 4)
        assert.ok(wait.Delays.every(ms => ms === 3000))
        assert.deepEqual([page.IsApplying, page.ApplyingText, page.CommandErrorText], [false, '', ''], 'no error is shown')
        assert.equal(page.NoticeText, 'Applied version 2 to pragmatic-system.')
        assert.deepEqual(page.ApplyRows.ToArray().map(r => [r.VersionText, r.OutcomeText]), [['Version 2', 'Applied']])
    })

    it("the console's own apply put back (never ready) says so once the console answers again", async () =>
    {
        const fx = new ConfigFixture()
        const wait = new InstantWait()
        const page = await fx.Console(wait)
        fx.Api.FailOn.set('ApplyConfigurationVersion', new TypeError('Failed to fetch'))
        wait.OnWait = n => { if (n === 2) fx.SettleConsoleApply(ConfigurationApplyOutcome.Failed, ConfigurationApplyDetails.RolloutNotReady) }
        page.ApplyCommand.Execute()
        for (let i = 0; i < 5 && page.IsApplying; i++) await Tick.Settle()
        assert.equal(page.NoticeText, 'Version 2 did not become ready on pragmatic-system: the previous configuration is running again.')
        assert.equal(page.CommandErrorText, '')
    })

    it('an apply the console answered still pending is waited for by its id; an earlier apply of the same version is not taken for it', async () =>
    {
        const fx = new ConfigFixture()
        const wait = new InstantWait()
        const page = await fx.Console(wait)
        fx.SettleConsoleApply(ConfigurationApplyOutcome.Applied, null, 'apply-earlier')
        await page.Refresh()
        fx.Api.ApplyOutcome = ConfigurationApplyOutcome.Pending
        wait.OnWait = n => { if (n === 2) fx.SettleConsoleApply(ConfigurationApplyOutcome.Failed, 'superseded', fx.Api.ConfigurationApplies.get(ConfigFixture.Console)![0]!.id) }
        page.ApplyCommand.Execute()
        for (let i = 0; i < 5 && page.IsApplying; i++) await Tick.Settle()
        assert.equal(wait.Waits, 2)
        assert.equal(page.NoticeText, 'Applying version 2 to pragmatic-system failed: superseded')
    })

    it('a console that does not answer within five minutes: the page says to reload, without an error', async () =>
    {
        const fx = new ConfigFixture()
        const wait = new InstantWait()
        const page = await fx.Console(wait)
        fx.Api.FailOn.set('ApplyConfigurationVersion', new ApiError(504, 'Request failed: 504'))
        wait.OnWait = n => { if (n === 1) fx.Api.FailOn.set('GetConfigurationComponent', new ApiError(503, 'Request failed: 503')) }
        page.ApplyCommand.Execute()
        for (let i = 0; i < 20 && page.IsApplying; i++) await Tick.Settle()
        assert.equal(wait.Waits, 100)
        assert.equal(wait.Delays.reduce((a, b) => a + b, 0), 5 * 60 * 1000)
        assert.equal(page.NoticeText, 'The console did not answer within five minutes: reload this page to see how the apply ended.')
        assert.equal(page.IsApplying, false)
    })

    it('the five minutes are a deadline from the click: a read the ingress holds open times out after 10 s and counts against it (review I5)', async () =>
    {
        const fx = new ConfigFixture()
        const wait = new InstantWait()
        const page = await fx.Console(wait)
        fx.Api.FailOn.set('ApplyConfigurationVersion', new TypeError('Failed to fetch'))
        wait.TimeoutsFire = true
        wait.OnWait = () => fx.Api.HangNext.set('GetConfigurationComponent', 1)
        page.ApplyCommand.Execute()
        for (let i = 0; i < 20 && page.IsApplying; i++) await Tick.Settle()
        assert.equal(wait.Waits, 24, 'each try: 3 s apart plus a 10 s read, until 300 s have passed')
        assert.ok(wait.Clock >= 5 * 60 * 1000 && wait.Clock < 5 * 60 * 1000 + 13000)
        assert.equal(page.NoticeText, 'The console did not answer within five minutes: reload this page to see how the apply ended.')
    })

    it('an ingress 404 without the console\'s JSON body is the console gone; a 404 the console answers is an error (review M1)', async () =>
    {
        const fx = new ConfigFixture()
        const wait = new InstantWait()
        const page = await fx.Console(wait)
        fx.Api.FailOn.set('ApplyConfigurationVersion', new ApiError(404, 'Request failed: 404'))
        wait.OnWait = n => { if (n === 1) fx.SettleConsoleApply(ConfigurationApplyOutcome.Applied) }
        page.ApplyCommand.Execute()
        for (let i = 0; i < 5 && page.IsApplying; i++) await Tick.Settle()
        assert.deepEqual([page.NoticeText, page.CommandErrorText], ['Applied version 2 to pragmatic-system.', ''])
        fx.Api.FailOn.set('ApplyConfigurationVersion', new ApiError(404, 'unknown version', 'not-found', { error: 'unknown version', code: 'not-found' }))
        page.ApplyCommand.Execute()
        await Tick.Settle()
        assert.equal(page.CommandErrorText, 'unknown version')
    })

    it('leaving the page stops the wait: no more reads, no notice (review M2)', async () =>
    {
        const fx = new ConfigFixture()
        const wait = new InstantWait()
        const page = await fx.Console(wait)
        fx.Api.FailOn.set('ApplyConfigurationVersion', new ApiError(502, 'Request failed: 502'))
        wait.OnWait = n => { if (n === 2) page.OnHidden() }
        page.ApplyCommand.Execute()
        for (let i = 0; i < 5 && page.IsApplying; i++) await Tick.Settle()
        assert.equal(wait.Waits, 2)
        assert.deepEqual([page.IsApplying, page.NoticeText, page.CommandErrorText], [false, '', ''])
        page.OnShown()
    })

    it('an apply of the same version to the same target recorded before the click (another admin) is not taken for this one (review M3)', async () =>
    {
        const fx = new ConfigFixture()
        const wait = new InstantWait()
        const page = await fx.Console(wait)
        // Recorded after the page loaded, so the page's own list does not hold it.
        fx.SettleConsoleApply(ConfigurationApplyOutcome.Applied, null, 'apply-other-admin')
        fx.Api.FailOn.set('ApplyConfigurationVersion', new ApiError(502, 'Request failed: 502'))
        wait.OnWait = n => { if (n === 2) fx.SettleConsoleApply(ConfigurationApplyOutcome.Failed, ConfigurationApplyDetails.RolloutNotReady) }
        page.ApplyCommand.Execute()
        for (let i = 0; i < 5 && page.IsApplying; i++) await Tick.Settle()
        assert.equal(page.NoticeText, 'Version 2 did not become ready on pragmatic-system: the previous configuration is running again.')
    })

    it("another component's 502, or a refusal of the console's own apply, is still an error", async () =>
    {
        const fx = new ConfigFixture()
        const page = await fx.Component()
        page.SelectedTarget = page.TargetOptions.ToArray()[0]
        fx.Api.FailOn.set('ApplyConfigurationVersion', new ApiError(502, 'Request failed: 502'))
        page.ApplyCommand.Execute()
        await Tick.Settle()
        assert.equal(page.CommandErrorText, 'Request failed: 502')
        assert.equal(page.IsApplying, false)
        const wait = new InstantWait()
        const own = await fx.Console(wait)
        fx.Api.FailOn.set('ApplyConfigurationVersion', new ApiError(409, 'an apply to this target is still being proven'))
        own.ApplyCommand.Execute()
        await Tick.Settle()
        assert.equal(own.CommandErrorText, 'an apply to this target is still being proven')
        assert.equal(wait.Waits, 0)
    })

    it('writes a secret value and keeps only its reference', async () =>
    {
        const fx = new ConfigFixture()
        const page = await fx.Component()
        assert.equal(page.SecretCommand.CanExecute(undefined), false)
        page.SecretName = 'graph-db'
        page.SecretValue = 'hunter2'
        assert.equal(page.SecretCommand.CanExecute(undefined), false, 'a secret is written for one chosen target')
        page.SelectedTarget = page.TargetOptions.ToArray()[1]
        page.SecretCommand.Execute()
        await Tick.Settle()
        assert.equal(fx.Api.Secrets.get('graph/staging/graph-db'), 'hunter2')
        assert.deepEqual(fx.Api.Calls.find(c => c[0] === 'PutConfigurationSecret'), ['PutConfigurationSecret', 'graph', 'staging', 'graph-db'])
        assert.equal(page.SecretValue, '', 'the value leaves the page once written')
        assert.equal(page.NoticeText, 'Saved secret graph-db; refer to it as secret:file/graph-db.')
    })

    it('offers save and apply only with the settings permission (the tenant admin role); reads stay open', async () =>
    {
        const fx = new ConfigFixture(false)
        const page = await fx.Component()
        assert.equal(page.State, PageState.Populated)
        assert.equal(page.CanMutate, false)
        assert.equal(page.DeniedReason, 'Needs the Manage tenant settings permission. Ask owner@example.test.')
        page.Editor.Text = '{ "database": {} }'
        page.SelectedTarget = page.TargetOptions.ToArray()[0]
        assert.equal(page.SaveCommand.CanExecute(), false)
        assert.equal(page.ApplyCommand.CanExecute(), false)
        assert.equal(page.CompareCommand.CanExecute(), true)
    })
})

describe('ConfigurationEditorViewModel', () =>
{
    it('is dirty once the text differs from the version it is based on', () =>
    {
        const editor = new ConfigurationEditorViewModel()
        editor.Reset(1, { a: 1 })
        assert.equal(editor.IsDirty, false)
        editor.Text = '{ "a": 2 }'
        assert.equal(editor.IsDirty, true)
        assert.deepEqual(editor.Document, { a: 2 })
        editor.Reset(2, { a: 2 })
        assert.equal(editor.IsDirty, false)
        assert.equal(editor.BasedOnText, 'Based on version 2.')
    })
})

describe('ConfigurationSectionService', () =>
{
    it('opens a component from the list and goes back to the list', async () =>
    {
        const fx = new ConfigFixture()
        fx.Host.Provider.register(ConfigurationSectionService.Key, (p) => new ConfigurationSectionService(p))
        const rail = new TestRail(fx.Host.Provider)
        rail.Add(ConfigurationSectionService.Key)
        rail.Select(ConfigurationSectionService.Key)
        await Tick.Settle()
        const content = (): unknown => fx.Host.Provider.getRequired(ContentHostService.Key).Content
        const list = content()
        assert.ok(list instanceof ConfigurationPageViewModel)
        list.Rows.ToArray()[0]!.OpenCommand.Execute()
        await Tick.Settle()
        const detail = content()
        assert.ok(detail instanceof ComponentConfigurationPageViewModel)
        assert.equal(detail.Title, 'graph')
        assert.equal(detail.State, PageState.Populated)
        detail.BackCommand.Execute()
        await Tick.Settle()
        assert.ok(content() instanceof ConfigurationPageViewModel)
    })
})

describe('Configuration target text', () =>
{
    const target = { environment: 'pragmatic-idp-t1', hive: 'h1', namespace: 'pragmatic-idp-t1', deployment: 'pragmatic-idp-t1', applied: 3 }

    it('says which prepared entry the pods run when it is not the applied file', () =>
    {
        const row = new ConfigurationTargetRowViewModel({ ...target, runs: { version: 2, componentVersion: '0.2.5', appliedVersion: 3 } })
        assert.equal(row.AppliedText, 'Version 3 applied; runs version 2 (prepared for 0.2.5)')
        assert.equal(new ConfigurationTargetRowViewModel({ ...target, runs: null }).AppliedText, 'Version 3 applied')
    })

    it('says a target runs a version that reads no configuration, so nothing applied there would change it', () =>
    {
        const row = new ConfigurationTargetRowViewModel({ ...target, applied: null, componentVersion: '0.1.0', readsConfiguration: false })
        assert.equal(row.AppliedText, 'Runs 0.1.0, which reads no configuration: update it before applying one')
        assert.equal(new ConfigurationTargetRowViewModel({ ...target, readsConfiguration: true }).AppliedText, 'Version 3 applied')
    })
})
