import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { ApiError } from '../../tenant-api-client.js'
import { AdminCapability } from '../../shell/admin-capability.js'
import { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'
import { UtcText } from '../../shell/utc-text.js'
import type { KeptIntentDto } from '../../tenant-types.js'
import { IntentSentences } from './intent-sentences.js'
import { DecisionRefusal, IntentFailureDto, IntentProgressDto } from './intent-wire.js'
import { ShownPage, type IShownPage } from '../../shell/shown-page.js'

export { DecisionRefusal, IntentFailureDto, IntentProgressDto } from './intent-wire.js'

// Starts and stops the expiry re-check (setTimeout in the browser; a manual one in tests).
export interface IExpiryTimer
{
    Start(delayMs: number, tick: () => void): void
    Stop(): void
}

export class TimeoutExpiryTimer implements IExpiryTimer
{
    private handle: ReturnType<typeof setTimeout> | undefined

    // At most a day at a time (a longer timeout overflows and fires at once); a later tick schedules the next.
    private static readonly MaxDelayMs = 86_400_000

    public Start(delayMs: number, tick: () => void): void
    {
        this.Stop()
        const handle = setTimeout(tick, Math.min(delayMs, TimeoutExpiryTimer.MaxDelayMs)) as ReturnType<typeof setTimeout> & { unref?: () => void }
        // In node (tests) the re-check never holds the process open.
        handle.unref?.()
        this.handle = handle
    }

    public Stop(): void
    {
        if (this.handle !== undefined)
        {
            clearTimeout(this.handle)
            this.handle = undefined
        }
    }
}

// One intent on the Approvals page: what it asks in plain words, when it
// expires, where it stands; Approve and Reject only while it waits and has not
// expired (an expired one is shown, never approvable: Pragmatic may send it again).
export class ApprovalRowViewModel extends Observable
{
    public static readonly RefusalMessages: Readonly<Record<DecisionRefusal, string>> = {
        [DecisionRefusal.Malformed]: 'This change could not be decided. Reload the page and try again.',
        [DecisionRefusal.NotEnrolled]: 'This hive is not connected to Pragmatic, so it keeps no changes to approve.',
        [DecisionRefusal.UnknownIntent]: 'This change is no longer on your hive. Reload the page.',
        [DecisionRefusal.NotAwaiting]: 'This change was already decided. Reload the page.',
        [DecisionRefusal.Expired]: 'This change expired before it was decided. Pragmatic can send it again.',
        [DecisionRefusal.DigestMismatch]: 'Pragmatic sent this change again with different content. Reload the page and check it before deciding.',
        [DecisionRefusal.Unavailable]: 'Your hive could not record the decision right now. Try again in a moment.',
    }
    public static readonly ForbiddenMessage = 'You need the tenant admin role to approve or reject changes.'
    private static readonly ProgressLabels: Readonly<Record<IntentProgressDto, string>> = {
        [IntentProgressDto.AwaitingApproval]: 'Waiting for approval',
        [IntentProgressDto.Applying]: 'Applying',
        [IntentProgressDto.Applied]: 'Applied',
        [IntentProgressDto.Rejected]: 'Rejected',
        [IntentProgressDto.Failed]: 'Failed',
        [IntentProgressDto.Expired]: 'Expired',
    }
    private static readonly FailedTemplate = 'Failed: {failure}'
    private static readonly FailureToken = '{failure}'
    private static readonly FailureWords: Readonly<Record<IntentFailureDto, string>> = {
        [IntentFailureDto.PrecheckRefused]: 'your hive refused it (it does not fit this hive)',
        [IntentFailureDto.EnvironmentNotFound]: 'the environment does not exist',
        [IntentFailureDto.EnvironmentExists]: 'an environment of that name exists already',
        [IntentFailureDto.VersionUnavailable]: 'that version is not the one this hive runs',
        [IntentFailureDto.NotReady]: 'it was applied but never became ready; the previous state was kept',
        [IntentFailureDto.ConsoleUnavailable]: 'this console could not be reached in time',
        [IntentFailureDto.RotationRefused]: 'the key change was not confirmed',
        [IntentFailureDto.RecheckFailed]: 'it no longer passed its signature check',
        [IntentFailureDto.ApplyFailed]: 'applying it failed',
    }
    private static readonly UnknownFailure = 'for a reason this console does not know'
    private static readonly RowChanges: readonly string[] = ['IsExpired', 'IsPending', 'StatusText', 'ExpiryText', 'CanDecide']
    private static readonly ExpiresTemplate = 'Expires {at}'
    private static readonly ExpiredTemplate = 'Expired {at}'
    private static readonly AtToken = '{at}'
    private static readonly NoText = ''
    private static readonly ApproveText = 'Approve'
    private static readonly RejectText = 'Reject'
    private static readonly ErrorTextProperty = 'ErrorText'
    private static readonly IsBusyProperty = 'IsBusy'

    private readonly approveCommand: RelayCommand
    private readonly rejectCommand: RelayCommand
    private errorText = ''
    private busy = false

    public constructor(private readonly session: TenantSessionService, public readonly Intent: KeptIntentDto, private readonly now: () => Date, private readonly onDecided: () => void)
    {
        super()
        const R = ApprovalRowViewModel
        this.approveCommand = new RelayCommand(() => { void this.Decide(true) }, () => this.CanDecide, { Text: R.ApproveText })
        this.rejectCommand = new RelayCommand(() => { void this.Decide(false) }, () => this.CanDecide, { Text: R.RejectText })
    }

    public get Sentence(): string
    {
        return IntentSentences.Of(this.Intent)
    }

    // Expired by its report, or still waiting past its expiry.
    public get IsExpired(): boolean
    {
        return this.Intent.Progress === IntentProgressDto.Expired
            || (this.Intent.Progress === IntentProgressDto.AwaitingApproval && Date.parse(this.Intent.ExpiresAt) <= this.now().getTime())
    }

    // Waiting for a decision and not expired: Approve and Reject are shown.
    public get IsPending(): boolean
    {
        return this.Intent.Progress === IntentProgressDto.AwaitingApproval && !this.IsExpired
    }

    public get StatusText(): string
    {
        const R = ApprovalRowViewModel
        if (this.IsExpired)
        {
            return R.ProgressLabels[IntentProgressDto.Expired]
        }
        if (this.Intent.Progress === IntentProgressDto.Failed && this.Intent.Failure !== null)
        {
            return R.FailedTemplate.replace(R.FailureToken, R.FailureWords[this.Intent.Failure as IntentFailureDto] ?? R.UnknownFailure)
        }
        return R.ProgressLabels[this.Intent.Progress as IntentProgressDto] ?? this.Intent.Progress
    }

    public get ExpiryText(): string
    {
        const R = ApprovalRowViewModel
        return (this.IsExpired ? R.ExpiredTemplate : R.ExpiresTemplate).replace(R.AtToken, UtcText.DateTime(this.Intent.ExpiresAt))
    }

    public get CanDecide(): boolean
    {
        return this.IsPending && !this.busy && this.session.Can(AdminCapability.Settings)
    }

    // Why Approve and Reject are disabled for this user ('' when allowed).
    public get DeniedReason(): string
    {
        return this.session.DeniedReason(AdminCapability.Settings)
    }

    public get ApproveCommand(): RelayCommand
    {
        return this.approveCommand
    }

    public get RejectCommand(): RelayCommand
    {
        return this.rejectCommand
    }

    public get ErrorText(): string
    {
        return this.errorText
    }

    public get IsBusy(): boolean
    {
        return this.busy
    }

    // The fixed message for a refused decision: the agent's code, else the role refusal, else unavailable.
    public static MessageFor(error: unknown): string
    {
        const R = ApprovalRowViewModel
        if (error instanceof ApiError && error.Status === ApiError.ForbiddenStatus && error.Code === undefined)
        {
            return R.ForbiddenMessage
        }
        const code = error instanceof ApiError ? error.Code : undefined
        return code !== undefined && code in R.RefusalMessages ? R.RefusalMessages[code as DecisionRefusal] : R.RefusalMessages[DecisionRefusal.Unavailable]
    }

    // Re-reads the clock: a row that expired meanwhile stops offering Approve and Reject.
    public RecheckExpiry(): void
    {
        for (const name of ApprovalRowViewModel.RowChanges)
        {
            this.RaisePropertyChanged(name, undefined, undefined)
        }
        this.approveCommand.RaiseCanExecuteChanged()
        this.rejectCommand.RaiseCanExecuteChanged()
    }

    public async Decide(approve: boolean): Promise<void>
    {
        const R = ApprovalRowViewModel
        if (!this.CanDecide)
        {
            // Expired since the page drew it: show it so, and ask nothing.
            this.RecheckExpiry()
            return
        }
        this.SetBusy(true)
        this.SetError(R.NoText)
        try
        {
            const client = this.session.Client
            await (approve ? client.ApproveIntent(this.Intent.IntentId, this.Intent.IntentDigest) : client.RejectIntent(this.Intent.IntentId, this.Intent.IntentDigest))
            this.onDecided()
        }
        catch (e)
        {
            if (e instanceof ApiError && e.Status === ApiError.UnauthorizedStatus)
            {
                throw e
            }
            this.SetError(R.MessageFor(e))
        }
        finally
        {
            this.SetBusy(false)
        }
    }

    private SetBusy(value: boolean): void
    {
        const old = this.busy
        if (old === value)
        {
            return
        }
        this.busy = value
        this.RaisePropertyChanged(ApprovalRowViewModel.IsBusyProperty, old, value)
        this.approveCommand.RaiseCanExecuteChanged()
        this.rejectCommand.RaiseCanExecuteChanged()
    }

    private SetError(value: string): void
    {
        const old = this.errorText
        if (old === value)
        {
            return
        }
        this.errorText = value
        this.RaisePropertyChanged(ApprovalRowViewModel.ErrorTextProperty, old, value)
    }
}

// The Approvals page (C3.4): the changes Pragmatic asked this hive to make,
// newest first. In an Enrolled hive each waits here until a tenant admin
// approves or rejects it; a Delegated hive applies them at once and lists them
// for the record. A console whose hive is not connected has none (Empty).
export class ApprovalsViewModel extends TenantPageViewModel implements IShownPage
{
    private static readonly RowsProperty = 'Rows'
    private static readonly PendingCountProperty = 'PendingCount'
    private static readonly HasPendingProperty = 'HasPending'
    private static readonly HasNoPendingProperty = 'HasNoPending'
    private static readonly ExpiryGraceMs = 1000

    private rows = new ObservableCollection<ApprovalRowViewModel>()

    public constructor(
        session: TenantSessionService,
        private readonly onPendingChanged: (count: number) => void = () => undefined,
        private readonly now: () => Date = () => new Date(),
        private readonly expiry: IExpiryTimer = new TimeoutExpiryTimer())
    {
        super(session)
        ShownPage.Register(this)
    }

    // On screen again: wait for the next expiry.
    public OnShown(): void
    {
        this.ScheduleExpiry()
    }

    // Off screen (popped, covered, another section): nothing waits for an expiry.
    public OnHidden(): void
    {
        this.expiry.Stop()
    }

    // The page goes away for good (its section is disposed).
    public Dispose(): void
    {
        this.expiry.Stop()
    }

    // Re-checks every row's expiry now (the timer's tick), then waits for the next one to expire.
    public RecheckExpiry(): void
    {
        const before = this.PendingCount
        for (const row of this.rows.ToArray())
        {
            row.RecheckExpiry()
        }
        this.RaisePending(before)
        this.ScheduleExpiry()
    }

    public get Rows(): ObservableCollection<ApprovalRowViewModel>
    {
        return this.rows
    }

    public get PendingCount(): number
    {
        return this.rows.ToArray().filter(row => row.IsPending).length
    }

    public get HasPending(): boolean
    {
        return this.PendingCount > 0
    }

    public get HasNoPending(): boolean
    {
        return !this.HasPending
    }

    protected override get PageCapability(): AdminCapability | undefined
    {
        return AdminCapability.Settings
    }

    protected override async LoadCore(): Promise<boolean>
    {
        const generation = this.LoadGeneration
        let intents: readonly KeptIntentDto[]
        try
        {
            intents = (await this.Session.Client.ListIntents()).Intents
        }
        catch (e)
        {
            // Only a connected engine's console serves intents.
            if (e instanceof ApiError && e.Status === ApiError.NotFoundStatus)
            {
                intents = []
            }
            else
            {
                throw e
            }
        }
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        this.Apply(intents)
        return intents.length > 0
    }

    private Apply(intents: readonly KeptIntentDto[]): void
    {
        const A = ApprovalsViewModel
        const before = [this.PendingCount] as const
        const old = this.rows
        this.rows = new ObservableCollection<ApprovalRowViewModel>()
        for (const intent of intents)
        {
            this.rows.Add(new ApprovalRowViewModel(this.Session, intent, this.now, () => { void this.Refresh() }))
        }
        this.RaisePropertyChanged(A.RowsProperty, old, this.rows)
        this.RaisePending(before[0])
        this.ScheduleExpiry()
    }

    private RaisePending(before: number): void
    {
        const A = ApprovalsViewModel
        this.RaisePropertyChanged(A.PendingCountProperty, before, this.PendingCount)
        this.RaisePropertyChanged(A.HasPendingProperty, before > 0, this.HasPending)
        this.RaisePropertyChanged(A.HasNoPendingProperty, before === 0, this.HasNoPending)
        this.onPendingChanged(this.PendingCount)
    }

    // The next pending row's expiry, a moment after it passes; none while nothing waits.
    private ScheduleExpiry(): void
    {
        const now = this.now().getTime()
        const next = this.rows.ToArray().filter(row => row.IsPending).map(row => Date.parse(row.Intent.ExpiresAt)).sort((a, b) => a - b)[0]
        if (next === undefined)
        {
            this.expiry.Stop()
            return
        }
        this.expiry.Start(Math.max(0, next - now) + ApprovalsViewModel.ExpiryGraceMs, () => this.RecheckExpiry())
    }
}
