import { RelayCommand, ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { ApiError } from '../../tenant-api-client.js'
import { TenantSectionService } from '../../shell/tenant-section-service.js'
import type { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import { ApprovalRowViewModel, ApprovalsViewModel } from './approvals-view-model.js'

// The Approvals rail section (C3.4): one page of the platform's changes, and
// the header's badge with how many wait for a decision (hidden at none, and on
// a console whose hive is not connected). The count is read once when the
// header first shows it, again on every load of the page and after a decision.
export class ApprovalsSectionService extends TenantSectionService
{
    public static readonly Key = new ServiceKey<ApprovalsSectionService>('ApprovalsSectionService')
    private static readonly PendingCountProperty = 'PendingCount'
    private static readonly HasPendingProperty = 'HasPending'
    private static readonly PendingTextProperty = 'PendingText'
    private static readonly OneTemplate = '1 change to approve'
    private static readonly ManyTemplate = '{count} changes to approve'
    private static readonly CountToken = '{count}'
    private static readonly NoText = ''

    private readonly openCommand: RelayCommand
    private pending = 0
    private counted = false

    public constructor(provider: IServiceProvider)
    {
        super(provider)
        this.openCommand = new RelayCommand(() => this.BringToFront())
    }

    public get PendingCount(): number
    {
        this.CountOnce()
        return this.pending
    }

    public get HasPending(): boolean
    {
        return this.PendingCount > 0
    }

    public get PendingText(): string
    {
        return this.PendingTextOf(this.PendingCount)
    }

    // Brings Approvals to the front (the header badge's click).
    public get OpenCommand(): RelayCommand
    {
        return this.openCommand
    }

    // Reads the count from the hive (outside the page); a console without intents counts none.
    public async CountPending(now: Date = new Date()): Promise<void>
    {
        try
        {
            const intents = (await this.Session.Client.ListIntents()).Intents
            this.SetPending(intents.filter(intent => new ApprovalRowViewModel(this.Session, intent, () => now, () => undefined).IsPending).length)
        }
        catch (e)
        {
            if (e instanceof ApiError && e.Status === ApiError.UnauthorizedStatus)
            {
                throw e
            }
            this.SetPending(0)
        }
    }

    protected override CreateRoot(): TenantPageViewModel
    {
        return new ApprovalsViewModel(this.Session, count => this.SetPending(count))
    }

    private CountOnce(): void
    {
        if (!this.counted)
        {
            this.counted = true
            void this.CountPending().catch(() => undefined)
        }
    }

    private SetPending(count: number): void
    {
        const A = ApprovalsSectionService
        this.counted = true
        const before = [this.pending, this.pending > 0, this.PendingTextOf(this.pending)] as const
        if (before[0] === count)
        {
            return
        }
        this.pending = count
        this.RaisePropertyChanged(A.PendingCountProperty, before[0], count)
        this.RaisePropertyChanged(A.HasPendingProperty, before[1], count > 0)
        this.RaisePropertyChanged(A.PendingTextProperty, before[2], this.PendingTextOf(count))
    }

    private PendingTextOf(count: number): string
    {
        const A = ApprovalsSectionService
        return count === 0 ? A.NoText : count === 1 ? A.OneTemplate : A.ManyTemplate.replace(A.CountToken, String(count))
    }
}
