import { ObservableCollection } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { ApiError } from '../../tenant-api-client.js'
import type { HiveEnrolmentDto, HiveRolloutDto, RolloutEnvDto } from '../../tenant-types.js'
import { ConnectHiveViewModel } from './connect-hive-view-model.js'
import { EngineConnection } from '../../shell/engine-connection.js'
import { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'

// One environment as the hive's rollout probe reports it.
export class ConnectionEnvironmentRowViewModel extends Observable
{
    private static readonly NoImage = 'no image reported'
    private static readonly HealthyLabel = 'Healthy'
    private static readonly DegradedLabel = 'Degraded'

    public constructor(private readonly env: RolloutEnvDto)
    {
        super()
    }

    public get Name(): string
    {
        return this.env.environmentName
    }

    public get Image(): string
    {
        return this.env.runningImage ?? ConnectionEnvironmentRowViewModel.NoImage
    }

    public get HealthLabel(): string
    {
        return this.env.ready ? ConnectionEnvironmentRowViewModel.HealthyLabel : ConnectionEnvironmentRowViewModel.DegradedLabel
    }
}

// How the hive's engine is linked to Pragmatic: through its agent channel
// (connected or quiet), not yet (a connected engine before enrolment: the
// page offers "Connect this hive"), or never (a standalone engine).
export enum ConnectionKind
{
    Channel,
    NotEnrolled,
    Standalone,
    // Enrolled by its key over the signed agent channel (C3.3): it reports;
    // releases and environments arrive by intents (C3.4).
    Enrolled,
}

// Connection status: how the hive reaches Pragmatic. Read-only. The hive is
// the tenant's one hive; no hive is the Empty state. The rollout probe
// answering 503 means the link is quiet right now: that is a state of the
// connection (Populated, Quiet), not a failure of the page. 403 is Denied.
// A chart-installed engine without a channel is Populated too: standalone
// (404, code engine-standalone) or not enrolled yet (503, hive-not-enrolled).
export class ConnectionPageViewModel extends TenantPageViewModel
{
    private static readonly IsQuietProperty = 'IsQuiet'
    private static readonly HasChannelProperty = 'HasChannel'
    private static readonly IsStandaloneProperty = 'IsStandalone'
    private static readonly IsNotEnrolledProperty = 'IsNotEnrolled'
    private static readonly IsEnrolledProperty = 'IsEnrolled'
    private static readonly ConnectProperty = 'Connect'
    private static readonly HasConnectProperty = 'HasConnect'
    private static readonly EnrolledLabel = 'Connected'
    private static readonly EnrolledHeadlineTemplate = 'This hive is connected to Pragmatic as hive {hive} ({level}).'
    private static readonly HiveToken = '{hive}'
    private static readonly LevelToken = '{level}'
    private static readonly NoText = ''
    private static readonly StandaloneLabel = 'Standalone'
    private static readonly NotEnrolledLabel = 'Not connected'
    private static readonly StandaloneHeadline = 'This hive runs standalone: it never contacts Pragmatic.'
    private static readonly NotEnrolledHeadline = 'This hive is not connected to Pragmatic yet.'
    private static readonly IsConnectedProperty = 'IsConnected'
    private static readonly StatusLabelProperty = 'StatusLabel'
    private static readonly HeadlineProperty = 'Headline'
    private static readonly TargetVersionTextProperty = 'TargetVersionText'
    private static readonly HiveLabelProperty = 'HiveLabel'
    private static readonly RowsProperty = 'Rows'
    private static readonly HasRowsProperty = 'HasRows'
    private static readonly HasNoRowsProperty = 'HasNoRows'
    private static readonly NoRowsTextProperty = 'NoRowsText'
    private static readonly ConnectedLabel = 'Connected'
    private static readonly QuietLabel = 'Quiet'
    private static readonly ConnectedHeadline = 'Pragmatic is reachable from your hive.'
    private static readonly QuietHeadline = "Your hive can't reach Pragmatic right now."
    private static readonly TargetTemplate = 'Target version: {version}'
    private static readonly VersionToken = '{version}'
    private static readonly NoTarget = 'No target version set yet.'
    private static readonly NoEnvironments = 'No environments reported yet.'
    private static readonly QuietNoEnvironments = 'Running versions are unavailable while the link is quiet.'

    private quiet = false
    private kind = ConnectionKind.Channel
    private rollout: HiveRolloutDto | undefined
    private rows = new ObservableCollection<ConnectionEnvironmentRowViewModel>()
    private enrolment: HiveEnrolmentDto | undefined
    private connect: ConnectHiveViewModel | undefined

    public constructor(session: TenantSessionService)
    {
        super(session)
    }

    public get Kind(): ConnectionKind
    {
        return this.kind
    }

    // Whether the hive has an agent channel at all (connected or quiet).
    public get HasChannel(): boolean
    {
        return this.kind === ConnectionKind.Channel
    }

    public get IsStandalone(): boolean
    {
        return this.kind === ConnectionKind.Standalone
    }

    // A connected engine before enrolment: the page offers "Connect this hive".
    public get IsNotEnrolled(): boolean
    {
        return this.kind === ConnectionKind.NotEnrolled
    }

    // Enrolled by its key (C3.3): the hive reports to Pragmatic.
    public get IsEnrolled(): boolean
    {
        return this.kind === ConnectionKind.Enrolled
    }

    // "Connect this hive" (a connected engine before enrolment, whose console serves enrolment).
    public get Connect(): ConnectHiveViewModel | undefined
    {
        return this.connect
    }

    public get HasConnect(): boolean
    {
        return this.connect !== undefined
    }

    public get IsQuiet(): boolean
    {
        return this.HasChannel && this.quiet
    }

    public get IsConnected(): boolean
    {
        return this.HasChannel && !this.quiet
    }

    public get StatusLabel(): string
    {
        const P = ConnectionPageViewModel
        switch (this.kind)
        {
            case ConnectionKind.Standalone:
                return P.StandaloneLabel
            case ConnectionKind.NotEnrolled:
                return P.NotEnrolledLabel
            case ConnectionKind.Enrolled:
                return P.EnrolledLabel
            default:
                return this.quiet ? P.QuietLabel : P.ConnectedLabel
        }
    }

    public get Headline(): string
    {
        const P = ConnectionPageViewModel
        switch (this.kind)
        {
            case ConnectionKind.Standalone:
                return P.StandaloneHeadline
            case ConnectionKind.NotEnrolled:
                return P.NotEnrolledHeadline
            case ConnectionKind.Enrolled:
                return P.EnrolledHeadlineTemplate.replace(P.HiveToken, this.enrolment?.HiveId ?? P.NoText).replace(P.LevelToken, this.enrolment?.Level ?? P.NoText)
            default:
                return this.quiet ? P.QuietHeadline : P.ConnectedHeadline
        }
    }

    public get HiveLabel(): string
    {
        return this.Session.HiveLabel
    }

    public get TargetVersionText(): string
    {
        const target = this.rollout?.targetVersion
        return target === undefined
            ? ConnectionPageViewModel.NoTarget
            : ConnectionPageViewModel.TargetTemplate.replace(ConnectionPageViewModel.VersionToken, target)
    }

    public get Rows(): ObservableCollection<ConnectionEnvironmentRowViewModel>
    {
        return this.rows
    }

    public get HasRows(): boolean
    {
        return this.rows.Count > 0
    }

    // Shown instead of the environments list when it is empty.
    public get NoRowsText(): string
    {
        return this.quiet ? ConnectionPageViewModel.QuietNoEnvironments : ConnectionPageViewModel.NoEnvironments
    }

    public get HasNoRows(): boolean
    {
        return !this.HasRows
    }

    protected override async LoadCore(): Promise<boolean>
    {
        const generation = this.LoadGeneration
        const hiveId = await this.Session.ResolveHiveId()
        if (hiveId === undefined)
        {
            return false
        }
        let rollout: HiveRolloutDto | undefined
        let quiet = false
        let kind = ConnectionKind.Channel
        try
        {
            rollout = await this.Session.Client.GetRollout(hiveId)
        }
        catch (e)
        {
            if (EngineConnection.IsStandalone(e))
            {
                kind = ConnectionKind.Standalone
            }
            else if (EngineConnection.IsNotEnrolled(e))
            {
                kind = ConnectionKind.NotEnrolled
            }
            else if (e instanceof ApiError && e.Status === ApiError.UnavailableStatus)
            {
                quiet = true
            }
            else
            {
                throw e
            }
        }
        // A connected engine before (or after) enrolment: its console answers the enrolment; another console has none (404).
        let enrolment: HiveEnrolmentDto | undefined
        if (kind === ConnectionKind.NotEnrolled)
        {
            enrolment = await this.EnrolmentOrNone()
            if (enrolment?.Enrolled === true)
            {
                kind = ConnectionKind.Enrolled
            }
        }
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        this.enrolment = enrolment
        this.SetConnect(kind === ConnectionKind.NotEnrolled && enrolment !== undefined ? new ConnectHiveViewModel(this.Session, enrolment, () => { void this.Refresh() }) : undefined)
        this.Apply(quiet, rollout, kind)
        return true
    }

    private async EnrolmentOrNone(): Promise<HiveEnrolmentDto | undefined>
    {
        try
        {
            return await this.Session.Client.GetEnrolment()
        }
        catch (e)
        {
            if (e instanceof ApiError && e.Status === ApiError.NotFoundStatus)
            {
                return undefined
            }
            throw e
        }
    }

    private SetConnect(value: ConnectHiveViewModel | undefined): void
    {
        const P = ConnectionPageViewModel
        const before = this.HasConnect
        this.Assign(P.ConnectProperty, this.connect, value, v => { this.connect = v })
        this.RaisePropertyChanged(P.HasConnectProperty, before, this.HasConnect)
    }

    private Apply(quiet: boolean, rollout: HiveRolloutDto | undefined, kind: ConnectionKind = ConnectionKind.Channel): void
    {
        const P = ConnectionPageViewModel
        const before = [this.StatusLabel, this.Headline, this.TargetVersionText, this.HasRows, this.NoRowsText] as const
        const flags = [this.HasChannel, this.IsStandalone, this.IsNotEnrolled, this.IsConnected, this.IsEnrolled] as const
        const oldRows = this.rows
        const wasQuiet = this.IsQuiet
        this.quiet = quiet
        this.kind = kind
        this.rollout = rollout
        // A fresh collection each load: the list re-binds to it in one step.
        this.rows = new ObservableCollection<ConnectionEnvironmentRowViewModel>()
        for (const env of rollout?.environments ?? [])
        {
            this.rows.Add(new ConnectionEnvironmentRowViewModel(env))
        }
        this.RaisePropertyChanged(P.IsQuietProperty, wasQuiet, this.IsQuiet)
        this.RaisePropertyChanged(P.IsConnectedProperty, flags[3], this.IsConnected)
        this.RaisePropertyChanged(P.HasChannelProperty, flags[0], this.HasChannel)
        this.RaisePropertyChanged(P.IsStandaloneProperty, flags[1], this.IsStandalone)
        this.RaisePropertyChanged(P.IsNotEnrolledProperty, flags[2], this.IsNotEnrolled)
        this.RaisePropertyChanged(P.IsEnrolledProperty, flags[4], this.IsEnrolled)
        this.RaisePropertyChanged(P.StatusLabelProperty, before[0], this.StatusLabel)
        this.RaisePropertyChanged(P.HeadlineProperty, before[1], this.Headline)
        this.RaisePropertyChanged(P.TargetVersionTextProperty, before[2], this.TargetVersionText)
        this.RaisePropertyChanged(P.RowsProperty, oldRows, this.rows)
        this.RaisePropertyChanged(P.HasRowsProperty, before[3], this.HasRows)
        this.RaisePropertyChanged(P.HasNoRowsProperty, !before[3], this.HasNoRows)
        this.RaisePropertyChanged(P.NoRowsTextProperty, before[4], this.NoRowsText)
        this.RaisePropertyChanged(P.HiveLabelProperty, undefined, this.HiveLabel)
    }

    // Sets a field and raises its change when the value differs.
    private Assign<T>(name: string, old: T, next: T, assign: (value: T) => void): void
    {
        if (old === next)
        {
            return
        }
        assign(next)
        this.RaisePropertyChanged(name, old, next)
    }
}
