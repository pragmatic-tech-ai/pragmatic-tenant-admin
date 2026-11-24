import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { OptionViewModel } from '@pragmatic-tech-ai/pragmatic-app-shell'
import { ApiError } from '../../tenant-api-client.js'
import { AdminCapability } from '../../shell/admin-capability.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'
import { ConsoleAddressOptionDto, EnrolmentLevel, type EnrolHiveParams, type HiveEnrolmentDto } from '../../tenant-types.js'

// Why "connect this hive" was refused, as the console names it (the hive
// agent's codes, C3.3). Nothing from Pragmatic's own answer is shown.
export enum ConnectRefusal
{
    Malformed = 'malformed',
    InvalidCode = 'invalid-code',
    Mismatch = 'mismatch',
    AlreadyEnrolled = 'already-enrolled',
    KeyRegistered = 'key-registered',
    TrustRootMismatch = 'trust-root-mismatch',
    Unavailable = 'unavailable',
}

// "Connect this hive": the one-time code from the personal cabinet, the
// level (Enrolled or Delegated, with what each means), and where this
// console is reached (as the engine was installed; the plain hive subdomain
// also needs the ingress address). After enrolment the form gives way to the
// hive id and level.
export class ConnectHiveViewModel extends Observable
{
    public static readonly Messages: Readonly<Record<ConnectRefusal, string>> = {
        [ConnectRefusal.Malformed]: 'Check the code and the level, then try again.',
        [ConnectRefusal.InvalidCode]: 'This code is not valid: it is unknown, already used or expired. Start a new enrolment in your Pragmatic account.',
        [ConnectRefusal.Mismatch]: 'This code was issued for another tenant or level.',
        [ConnectRefusal.AlreadyEnrolled]: 'This hive is already connected.',
        [ConnectRefusal.KeyRegistered]: "This hive's key is already registered with Pragmatic. Contact Pragmatic support.",
        [ConnectRefusal.TrustRootMismatch]: 'Pragmatic answered under a key this engine was not installed to trust. Check that the engine was installed from Pragmatic\'s published chart.',
        [ConnectRefusal.Unavailable]: 'Pragmatic could not be reached from this hive. Try again in a moment.',
    }
    public static readonly ForbiddenMessage = 'You need the tenant admin role to connect this hive.'
    private static readonly EnrolledLabel = 'Enrolled'
    private static readonly DelegatedLabel = 'Delegated'
    private static readonly EnrolledHelp = 'Pragmatic announces each change (a new release, an environment) and you approve it here before your hive applies it.'
    private static readonly DelegatedHelp = 'Your hive applies the changes Pragmatic sends without asking first. You can still see each one here.'
    private static readonly OptionLabels: Readonly<Record<ConsoleAddressOptionDto, string>> = {
        [ConsoleAddressOptionDto.OwnDomain]: 'your own domain',
        [ConsoleAddressOptionDto.HiveSubdomain]: 'a Pragmatic hive subdomain',
        [ConsoleAddressOptionDto.RelayedHiveSubdomain]: 'a Pragmatic hive subdomain, relayed (private cluster)',
    }
    private static readonly AddressTemplate = '{host} ({option})'
    private static readonly HostToken = '{host}'
    private static readonly OptionToken = '{option}'
    private static readonly ConnectedTemplate = 'Connected as hive {hive} at level {level}.'
    private static readonly HiveToken = '{hive}'
    private static readonly LevelToken = '{level}'
    private static readonly NoText = ''
    private static readonly CodeProperty = 'Code'
    private static readonly IngressAddressProperty = 'IngressAddress'
    private static readonly SelectedLevelProperty = 'SelectedLevel'
    private static readonly LevelHelpProperty = 'LevelHelp'
    private static readonly ErrorTextProperty = 'ErrorText'
    private static readonly IsBusyProperty = 'IsBusy'
    private static readonly IsEnrolledProperty = 'IsEnrolled'
    private static readonly ShowsFormProperty = 'ShowsForm'
    private static readonly ConnectedTextProperty = 'ConnectedText'

    private readonly levels = new ObservableCollection<OptionViewModel<EnrolmentLevel>>()
    private readonly connectCommand: RelayCommand
    private code = ''
    private ingressAddress = ''
    private selectedLevel: OptionViewModel<EnrolmentLevel>
    private errorText = ''
    private busy = false
    private enrolment: HiveEnrolmentDto

    public constructor(private readonly session: TenantSessionService, enrolment: HiveEnrolmentDto, private readonly onEnrolled: (enrolment: HiveEnrolmentDto) => void = () => undefined)
    {
        super()
        const C = ConnectHiveViewModel
        this.enrolment = enrolment
        this.selectedLevel = new OptionViewModel(EnrolmentLevel.Enrolled, C.EnrolledLabel)
        this.levels.Add(this.selectedLevel)
        this.levels.Add(new OptionViewModel(EnrolmentLevel.Delegated, C.DelegatedLabel))
        this.connectCommand = new RelayCommand(() => { void this.Connect() }, () => this.CanConnect)
    }

    public get Code(): string
    {
        return this.code
    }

    public set Code(value: string)
    {
        this.Assign(ConnectHiveViewModel.CodeProperty, this.code, value ?? ConnectHiveViewModel.NoText, v => { this.code = v })
        this.connectCommand.RaiseCanExecuteChanged()
    }

    public get Levels(): ObservableCollection<OptionViewModel<EnrolmentLevel>>
    {
        return this.levels
    }

    public get SelectedLevel(): OptionViewModel<EnrolmentLevel>
    {
        return this.selectedLevel
    }

    public set SelectedLevel(value: OptionViewModel<EnrolmentLevel>)
    {
        if (value === undefined || value === null)
        {
            return
        }
        const help = this.LevelHelp
        this.Assign(ConnectHiveViewModel.SelectedLevelProperty, this.selectedLevel, value, v => { this.selectedLevel = v })
        this.RaisePropertyChanged(ConnectHiveViewModel.LevelHelpProperty, help, this.LevelHelp)
    }

    // The plain-language difference between the two levels, for the one chosen.
    public get LevelHelp(): string
    {
        return this.selectedLevel.Value === EnrolmentLevel.Delegated ? ConnectHiveViewModel.DelegatedHelp : ConnectHiveViewModel.EnrolledHelp
    }

    public get ConsoleAddressText(): string
    {
        const C = ConnectHiveViewModel
        const address = this.enrolment.ConsoleAddress
        return C.AddressTemplate.replace(C.HostToken, address.HostName).replace(C.OptionToken, C.OptionLabels[address.Option] ?? address.Option)
    }

    public get NeedsIngressAddress(): boolean
    {
        return this.enrolment.ConsoleAddress.NeedsIngressAddress
    }

    public get IngressAddress(): string
    {
        return this.ingressAddress
    }

    public set IngressAddress(value: string)
    {
        this.Assign(ConnectHiveViewModel.IngressAddressProperty, this.ingressAddress, value ?? ConnectHiveViewModel.NoText, v => { this.ingressAddress = v })
        this.connectCommand.RaiseCanExecuteChanged()
    }

    public get ConnectCommand(): RelayCommand
    {
        return this.connectCommand
    }

    // Why Connect is disabled for this user ('' when it is allowed).
    public get DeniedReason(): string
    {
        return this.session.DeniedReason(AdminCapability.Settings)
    }

    public get ErrorText(): string
    {
        return this.errorText
    }

    public get IsBusy(): boolean
    {
        return this.busy
    }

    public get IsEnrolled(): boolean
    {
        return this.enrolment.Enrolled
    }

    public get ShowsForm(): boolean
    {
        return !this.enrolment.Enrolled
    }

    public get ConnectedText(): string
    {
        const C = ConnectHiveViewModel
        const e = this.enrolment
        return e.Enrolled ? C.ConnectedTemplate.replace(C.HiveToken, e.HiveId ?? C.NoText).replace(C.LevelToken, e.Level ?? C.NoText) : C.NoText
    }

    public get CanConnect(): boolean
    {
        return !this.busy && !this.enrolment.Enrolled && this.code.trim() !== ConnectHiveViewModel.NoText
            && (!this.NeedsIngressAddress || this.ingressAddress.trim() !== ConnectHiveViewModel.NoText)
            && this.session.Can(AdminCapability.Settings)
    }

    // The fixed message for a refused connect: the agent's code, else the role refusal, else unavailable.
    public static MessageFor(error: unknown): string
    {
        const C = ConnectHiveViewModel
        if (error instanceof ApiError && error.Status === ApiError.ForbiddenStatus && error.Code === undefined)
        {
            return C.ForbiddenMessage
        }
        const code = error instanceof ApiError ? error.Code : undefined
        return code !== undefined && code in C.Messages ? C.Messages[code as ConnectRefusal] : C.Messages[ConnectRefusal.Unavailable]
    }

    public async Connect(): Promise<void>
    {
        const C = ConnectHiveViewModel
        if (!this.CanConnect)
        {
            return
        }
        this.SetBusy(true)
        this.SetError(C.NoText)
        const params: EnrolHiveParams = this.NeedsIngressAddress
            ? { Code: this.code.trim(), Level: this.selectedLevel.Value, IngressAddress: this.ingressAddress.trim() }
            : { Code: this.code.trim(), Level: this.selectedLevel.Value }
        try
        {
            const enrolled = await this.session.Client.EnrolHive(params)
            this.Apply(enrolled)
            this.onEnrolled(enrolled)
        }
        catch (e)
        {
            if (e instanceof ApiError && e.Status === ApiError.UnauthorizedStatus)
            {
                throw e
            }
            this.SetError(C.MessageFor(e))
        }
        finally
        {
            this.SetBusy(false)
        }
    }

    private Apply(enrolment: HiveEnrolmentDto): void
    {
        const C = ConnectHiveViewModel
        const before = [this.IsEnrolled, this.ShowsForm, this.ConnectedText] as const
        this.enrolment = enrolment
        this.RaisePropertyChanged(C.IsEnrolledProperty, before[0], this.IsEnrolled)
        this.RaisePropertyChanged(C.ShowsFormProperty, before[1], this.ShowsForm)
        this.RaisePropertyChanged(C.ConnectedTextProperty, before[2], this.ConnectedText)
        this.connectCommand.RaiseCanExecuteChanged()
    }

    private SetBusy(value: boolean): void
    {
        this.Assign(ConnectHiveViewModel.IsBusyProperty, this.busy, value, v => { this.busy = v })
        this.connectCommand.RaiseCanExecuteChanged()
    }

    private SetError(value: string): void
    {
        this.Assign(ConnectHiveViewModel.ErrorTextProperty, this.errorText, value, v => { this.errorText = v })
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
