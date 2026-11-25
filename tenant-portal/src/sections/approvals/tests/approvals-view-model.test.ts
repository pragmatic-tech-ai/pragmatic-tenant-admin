import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../../../tenant-api-client.js'
import type { KeptIntentDto } from '../../../tenant-types.js'
import { FakeTenantApi, TenantTestHost } from '../../../shell/tests/tenant-test-fixtures.js'
import { ApprovalRowViewModel, ApprovalsViewModel, DecisionRefusal, IntentProgressDto, type IExpiryTimer } from '../approvals-view-model.js'
import { ApprovalsSectionService } from '../approvals-section-service.js'
import { IntentSentences } from '../intent-sentences.js'

class ApprovalSamples
{
    public static readonly Now = new Date('2026-11-25T12:00:00.000Z')
    public static readonly Digest = 'sha256:' + 'e'.repeat(64)

    public static Intent(id: string, action: Record<string, unknown> & { Kind: string }, progress: IntentProgressDto = IntentProgressDto.AwaitingApproval, expiresAt: string = '2026-12-01T00:00:00.000Z'): KeptIntentDto
    {
        return { IntentId: id, IntentDigest: ApprovalSamples.Digest, Level: 'enrolled', Action: action, IssuedAt: '2026-11-24T00:00:00.000Z', ExpiresAt: expiresAt, Progress: progress, Failure: progress === IntentProgressDto.Failed ? 'environment-exists' : null }
    }

    public static Create(): KeptIntentDto
    {
        return ApprovalSamples.Intent('inaaaaaaaaaaaa', { Kind: 'create-environment', Environment: 'prod', Purpose: 'development', Version: null })
    }
}

describe('IntentSentences', () =>
{
    it('each action kind renders its sentence', () =>
    {
        const S = ApprovalSamples
        const cases: [Record<string, unknown> & { Kind: string }, string][] = [
            [{ Kind: 'component-at-version', Component: 'pragmatic-tenant-idp', Version: '0.3.1', ImageDigest: S.Digest, DescriptorDigest: S.Digest, Configuration: null }, 'Upgrade sign-in service to 0.3.1'],
            [{ Kind: 'component-at-version', Component: 'pragmatic-hive-agent', Version: '0.1.10', ImageDigest: S.Digest, DescriptorDigest: S.Digest, Configuration: null }, 'Upgrade hive agent to 0.1.10'],
            [{ Kind: 'create-environment', Environment: 'prod', Purpose: 'development', Version: null }, 'Create environment `prod`'],
            [{ Kind: 'create-environment', Environment: 'shop', Purpose: 'runtime', Version: null }, 'Create runtime environment `shop`'],
            [{ Kind: 'update-environment', Environment: 'prod', Version: '1.3.0' }, 'Move environment `prod` to 1.3.0'],
            [{ Kind: 'delete-environment', Environment: 'old' }, 'Delete environment `old`'],
            [{ Kind: 'rotate', Subject: 'hive-key', NewTrustRoot: null }, "Renew this hive's identity key"],
            [{ Kind: 'rotate', Subject: 'ingress-certificate', NewTrustRoot: null }, "Renew the console's certificate"],
            [{ Kind: 'rotate', Subject: 'trust-root', NewTrustRoot: 'k' }, "Trust Pragmatic's new signing key"],
            [{ Kind: 'repair', Scope: 'engine', Name: null }, 'Repair the engine'],
            [{ Kind: 'repair', Scope: 'component', Name: 'pragmatic-postgres' }, 'Repair the hive database'],
            [{ Kind: 'repair', Scope: 'environment', Name: 'prod' }, 'Repair environment `prod`'],
            [{ Kind: 'run-shell' }, 'A change this console does not recognise'],
        ]
        for (const [action, sentence] of cases)
        {
            assert.equal(IntentSentences.Of(S.Intent('inaaaaaaaaaaaa', action)), sentence)
        }
    })
})

describe('ApprovalsViewModel', () =>
{
    it('expired intents have no approve button; pending ones approve by the digest shown', async () =>
    {
        const api = new FakeTenantApi()
        api.Intents = [
            ApprovalSamples.Create(),
            ApprovalSamples.Intent('inbbbbbbbbbbbb', { Kind: 'delete-environment', Environment: 'old' }, IntentProgressDto.AwaitingApproval, '2026-11-25T00:00:00.000Z'),
            ApprovalSamples.Intent('incccccccccccc', { Kind: 'delete-environment', Environment: 'gone' }, IntentProgressDto.Expired),
            ApprovalSamples.Intent('indddddddddddd', { Kind: 'repair', Scope: 'engine', Name: null }, IntentProgressDto.Applied),
            ApprovalSamples.Intent('ineeeeeeeeeeee', { Kind: 'create-environment', Environment: 'qa', Purpose: 'development', Version: null }, IntentProgressDto.Failed),
        ]
        const counts: number[] = []
        const page = new ApprovalsViewModel(new TenantTestHost(api).Session, count => counts.push(count), () => ApprovalSamples.Now)
        await page.Refresh()
        assert.equal(page.IsPopulated, true)
        const rows = page.Rows.ToArray()
        assert.deepEqual(rows.map(row => row.IsPending), [true, false, false, false, false])
        assert.deepEqual(rows.map(row => row.StatusText), ['Waiting for approval', 'Expired', 'Expired', 'Applied', 'Failed: an environment of that name exists already'])
        assert.match(rows[1]!.ExpiryText, /^Expired 2026-11-25 00:00 UTC$/)
        assert.match(rows[0]!.ExpiryText, /^Expires 2026-12-01 00:00 UTC$/)
        assert.equal(rows[1]!.ApproveCommand.CanExecute(), false)
        assert.equal(rows[2]!.RejectCommand.CanExecute(), false)
        assert.equal(page.PendingCount, 1)
        assert.deepEqual(counts, [1])
        assert.equal(rows[0]!.ApproveCommand.CanExecute(), true)
        await rows[0]!.Decide(true)
        assert.deepEqual(api.Decided, [{ Id: 'inaaaaaaaaaaaa', Digest: ApprovalSamples.Digest, Approve: true }])
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(page.PendingCount, 0)
        assert.equal(counts.at(-1), 0)
    })

    it('a refused decision shows its fixed message; without the admin role the buttons are disabled', async () =>
    {
        const api = new FakeTenantApi()
        api.Intents = [ApprovalSamples.Create()]
        api.FailOn.set('RejectIntent', new ApiError(410, 'refused', DecisionRefusal.Expired))
        const page = new ApprovalsViewModel(new TenantTestHost(api).Session, undefined, () => ApprovalSamples.Now)
        await page.Refresh()
        const row = page.Rows.ToArray()[0]!
        await row.Decide(false)
        assert.equal(row.ErrorText, ApprovalRowViewModel.RefusalMessages[DecisionRefusal.Expired])
        assert.equal(ApprovalRowViewModel.MessageFor(new ApiError(503, 'anything', 'new-code')), ApprovalRowViewModel.RefusalMessages[DecisionRefusal.Unavailable])
        assert.equal(ApprovalRowViewModel.MessageFor(new ApiError(403, 'Forbidden')), ApprovalRowViewModel.ForbiddenMessage)
        const readOnly = new ApprovalsViewModel(new TenantTestHost(api, { envs: true, adopt: true, access: true, settings: false }).Session, undefined, () => ApprovalSamples.Now)
        await readOnly.Refresh()
        assert.equal(readOnly.Rows.ToArray()[0]!.ApproveCommand.CanExecute(), false)
        assert.notEqual(readOnly.Rows.ToArray()[0]!.DeniedReason, '')
    })

    it('a console that is not a connected engine\'s has no intents: the page is empty and the badge hidden', async () =>
    {
        const api = new FakeTenantApi()
        const page = new ApprovalsViewModel(new TenantTestHost(api).Session)
        await page.Refresh()
        assert.equal(page.IsEmpty, true)
        const host = new TenantTestHost(api)
        const section = new ApprovalsSectionService(host.Provider)
        await section.CountPending()
        assert.equal(section.HasPending, false)
        assert.equal(section.PendingText, '')
    })

    it('the navigation badge counts the intents waiting for a decision', async () =>
    {
        const api = new FakeTenantApi()
        api.Intents = [ApprovalSamples.Create(), ApprovalSamples.Intent('inbbbbbbbbbbbb', { Kind: 'delete-environment', Environment: 'old' })]
        const host = new TenantTestHost(api)
        const section = new ApprovalsSectionService(host.Provider)
        await section.CountPending(ApprovalSamples.Now)
        assert.equal(section.PendingCount, 2)
        assert.equal(section.PendingText, '2 changes to approve')
        api.Intents = [ApprovalSamples.Create()]
        await section.CountPending(ApprovalSamples.Now)
        assert.equal(section.PendingText, '1 change to approve')
    })
})

class ManualExpiryTimer implements IExpiryTimer
{
    public DelayMs: number | undefined
    public Tick: (() => void) | undefined

    public Start(delayMs: number, tick: () => void): void
    {
        this.DelayMs = delayMs
        this.Tick = tick
    }

    public Stop(): void
    {
        this.DelayMs = undefined
        this.Tick = undefined
    }
}

describe('ApprovalsViewModel expiry', () =>
{
    it('a row that expires while shown stops offering Approve, and deciding it asks nothing', async () =>
    {
        const api = new FakeTenantApi()
        api.Intents = [ApprovalSamples.Intent('inaaaaaaaaaaaa', { Kind: 'delete-environment', Environment: 'old' }, IntentProgressDto.AwaitingApproval, '2026-11-25T13:00:00.000Z')]
        let now = ApprovalSamples.Now
        const timer = new ManualExpiryTimer()
        const counts: number[] = []
        const page = new ApprovalsViewModel(new TenantTestHost(api).Session, count => counts.push(count), () => now, timer)
        await page.Refresh()
        const row = page.Rows.ToArray()[0]!
        assert.equal(row.ApproveCommand.CanExecute(), true)
        assert.equal(timer.DelayMs, 3_600_000 + 1000, 'the re-check waits for the expiry')
        now = new Date('2026-11-25T13:00:01.000Z')
        timer.Tick?.()
        assert.equal(row.ApproveCommand.CanExecute(), false)
        assert.equal(row.StatusText, 'Expired')
        assert.equal(page.PendingCount, 0)
        assert.equal(counts.at(-1), 0)
        assert.equal(timer.Tick, undefined, 'nothing left to wait for')
        await row.Decide(true)
        assert.deepEqual(api.Decided, [], 'an expired row asks nothing')
    })

    it('the expiry re-check stops when the page is hidden or disposed, and resumes when shown', async () =>
    {
        const api = new FakeTenantApi()
        api.Intents = [ApprovalSamples.Intent('inaaaaaaaaaaaa', { Kind: 'delete-environment', Environment: 'old' }, IntentProgressDto.AwaitingApproval, '2026-11-25T13:00:00.000Z')]
        const timer = new ManualExpiryTimer()
        const page = new ApprovalsViewModel(new TenantTestHost(api).Session, undefined, () => ApprovalSamples.Now, timer)
        await page.Refresh()
        assert.notEqual(timer.Tick, undefined)
        page.OnHidden()
        assert.equal(timer.Tick, undefined, 'hidden: nothing waits')
        page.OnShown()
        assert.notEqual(timer.Tick, undefined, 'shown: waits again')
        page.Dispose()
        assert.equal(timer.Tick, undefined, 'disposed: nothing waits')
    })

    it('a failure code reads in plain words', () =>
    {
        const row = new ApprovalRowViewModel(new TenantTestHost(new FakeTenantApi()).Session, { ...ApprovalSamples.Create(), Progress: 'failed', Failure: 'not-ready' }, () => ApprovalSamples.Now, () => undefined)
        assert.equal(row.StatusText, 'Failed: it was applied but never became ready; the previous state was kept')
        const unknown = new ApprovalRowViewModel(new TenantTestHost(new FakeTenantApi()).Session, { ...ApprovalSamples.Create(), Progress: 'failed', Failure: 'something-new' }, () => ApprovalSamples.Now, () => undefined)
        assert.equal(unknown.StatusText, 'Failed: for a reason this console does not know')
    })
})
