import {
    ConsoleIntentOutcome, EnvironmentPurpose, IntentActionKind, IntentFailure, RotationSubject,
    type ConsoleIntentCall, type CreateEnvironment, type DeleteEnvironment, type IntentAction, type Repair, type UpdateEnvironment,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import {
    EnvironmentExistsError, EnvStatus, Template, TemplateCatalog, type EnvironmentRecord, type IEnvironmentService, type IRecordMap,
} from '@pragmatic-tech-ai/pragmatic-tenant-plane'

/** Renews the console's ingress certificate; false when the certificate is not the engine's own (the operator's Secret). */
export interface IConsoleCertificateRenewal
{
    Renew(): Promise<boolean>
}

/** What the applier needs of the console. */
export interface EnvironmentIntentApplierOptions
{
    Service: Pick<IEnvironmentService, 'Create' | 'Delete' | 'Restart' | 'List'>
    /** The hive the console places environments on (its one hive). */
    HiveId: () => string
    /**
     * Who an intent's environment is created for: the tenant's Owner principal, seeded as its administrator as the
     * console's own create seeds the signed-in creator (a Delegated intent has no approver; an Enrolled one's approver
     * is a realm subject the environment does not know yet).
     */
    Creator: () => string
    /** The engine's release version (the chart's), or undefined when the chart names none. */
    EngineVersion: string | undefined
    /** Which environment each create intent created (intent id → environment name), so a retried intent is not a clash. */
    Created: IRecordMap<string>
    /** The certificate renewal; undefined when the console cannot renew (not a chart install, no cluster access). */
    Certificate: IConsoleCertificateRenewal | undefined
}

/**
 * Applies the intents the hive agent forwards to its console (C3.4 ruling "who applies what"): environments are the
 * console's, so create, update, delete and repair of an environment go through the console's own environment service,
 * as its tenant API does; the ingress-certificate rotation renews the console's certificate. Every outcome is applied or
 * a failure code, never text. Create is idempotent per intent id: an environment this intent created is applied, any
 * other of that name is `environment-exists`.
 */
export class EnvironmentIntentApplier
{
    private created: Map<string, string> | undefined
    /** The create each intent id is applying now: a retry while it runs answers with the same outcome. */
    private readonly inFlight = new Map<string, Promise<ConsoleIntentOutcome>>()

    public constructor(private readonly options: EnvironmentIntentApplierOptions)
    {
    }

    public async Apply(call: ConsoleIntentCall): Promise<ConsoleIntentOutcome>
    {
        const action: IntentAction = call.Action
        switch (action.Kind)
        {
            case IntentActionKind.CreateEnvironment:
                return this.Create(call.IntentId, action)
            case IntentActionKind.UpdateEnvironment:
                return this.Update(action)
            case IntentActionKind.DeleteEnvironment:
                return this.Delete(action)
            case IntentActionKind.Repair:
                return this.Repair(action)
            case IntentActionKind.Rotate:
                return action.Subject === RotationSubject.IngressCertificate ? this.RenewCertificate() : ConsoleIntentOutcome.FailedWith(IntentFailure.PrecheckRefused)
            default:
                return ConsoleIntentOutcome.FailedWith(IntentFailure.PrecheckRefused)
        }
    }

    /** The template an intent's purpose creates (development: a blank workspace; runtime: with its Postgres). */
    public static TemplateOf(purpose: EnvironmentPurpose): Template
    {
        return purpose === EnvironmentPurpose.Runtime ? Template.RuntimePostgres : Template.DevBlank
    }

    private Create(intentId: string, action: CreateEnvironment): Promise<ConsoleIntentOutcome>
    {
        const running = this.inFlight.get(intentId)
        if (running !== undefined)
        {
            return running
        }
        const started = this.CreateOnce(intentId, action).finally(() => this.inFlight.delete(intentId))
        this.inFlight.set(intentId, started)
        return started
    }

    /**
     * The intent's id is noted before the create, so a console that stops mid-create finds the environment its own on
     * the agent's retry (and creates it again if nothing was registered); it is removed when the name turned out to be
     * taken, so a later retry never reports someone else's environment as this intent's.
     */
    private async CreateOnce(intentId: string, action: CreateEnvironment): Promise<ConsoleIntentOutcome>
    {
        if (action.Version !== null && action.Version !== this.options.EngineVersion)
        {
            return ConsoleIntentOutcome.FailedWith(IntentFailure.VersionUnavailable)
        }
        const created = await this.Created()
        const existing = this.Find(action.Environment)
        if (created.get(intentId) === action.Environment && existing !== undefined)
        {
            return EnvironmentIntentApplier.OutcomeOf(existing)
        }
        if (existing !== undefined)
        {
            return ConsoleIntentOutcome.FailedWith(IntentFailure.EnvironmentExists)
        }
        await this.Note(intentId, action.Environment)
        const template = EnvironmentIntentApplier.TemplateOf(action.Purpose)
        try
        {
            return EnvironmentIntentApplier.OutcomeOf(await this.options.Service.Create(action.Environment, template, TemplateCatalog.DefaultTypeFor(template), undefined, this.options.HiveId(), this.options.Creator()))
        }
        catch (error)
        {
            if (error instanceof EnvironmentExistsError)
            {
                await this.Forget(intentId)
                return ConsoleIntentOutcome.FailedWith(IntentFailure.EnvironmentExists)
            }
            return ConsoleIntentOutcome.FailedWith(IntentFailure.ApplyFailed)
        }
    }

    /** Every environment runs the engine's environment server: the asked version must be the engine's; the environment is brought back onto it. */
    private async Update(action: UpdateEnvironment): Promise<ConsoleIntentOutcome>
    {
        if (action.Version !== this.options.EngineVersion)
        {
            return ConsoleIntentOutcome.FailedWith(IntentFailure.VersionUnavailable)
        }
        return this.Restart(action.Environment)
    }

    private async Delete(action: DeleteEnvironment): Promise<ConsoleIntentOutcome>
    {
        if (this.Find(action.Environment) === undefined)
        {
            return ConsoleIntentOutcome.Applied
        }
        try
        {
            await this.options.Service.Delete(action.Environment)
            return ConsoleIntentOutcome.Applied
        }
        catch
        {
            return ConsoleIntentOutcome.FailedWith(IntentFailure.ApplyFailed)
        }
    }

    private async Repair(action: Repair): Promise<ConsoleIntentOutcome>
    {
        return action.Name === null ? ConsoleIntentOutcome.FailedWith(IntentFailure.PrecheckRefused) : this.Restart(action.Name)
    }

    private async Restart(name: string): Promise<ConsoleIntentOutcome>
    {
        if (this.Find(name) === undefined)
        {
            return ConsoleIntentOutcome.FailedWith(IntentFailure.EnvironmentNotFound)
        }
        try
        {
            return EnvironmentIntentApplier.OutcomeOf(await this.options.Service.Restart(name))
        }
        catch
        {
            return ConsoleIntentOutcome.FailedWith(IntentFailure.ApplyFailed)
        }
    }

    private async RenewCertificate(): Promise<ConsoleIntentOutcome>
    {
        const certificate = this.options.Certificate
        if (certificate === undefined)
        {
            return ConsoleIntentOutcome.FailedWith(IntentFailure.PrecheckRefused)
        }
        try
        {
            return await certificate.Renew() ? ConsoleIntentOutcome.Applied : ConsoleIntentOutcome.FailedWith(IntentFailure.PrecheckRefused)
        }
        catch
        {
            return ConsoleIntentOutcome.FailedWith(IntentFailure.ApplyFailed)
        }
    }

    private Find(name: string): EnvironmentRecord | undefined
    {
        return this.options.Service.List().find(record => record.name === name)
    }

    private async Created(): Promise<Map<string, string>>
    {
        if (this.created === undefined)
        {
            this.created = new Map(await this.options.Created.Load())
        }
        return this.created
    }

    private async Note(intentId: string, environment: string): Promise<void>
    {
        const created = await this.Created()
        created.set(intentId, environment)
        await this.options.Created.Save(created, new Set([intentId]))
    }

    private async Forget(intentId: string): Promise<void>
    {
        const created = await this.Created()
        created.delete(intentId)
        await this.options.Created.Save(created, new Set([intentId]))
    }

    private static OutcomeOf(record: EnvironmentRecord): ConsoleIntentOutcome
    {
        return record.status === EnvStatus.Failed ? ConsoleIntentOutcome.FailedWith(IntentFailure.NotReady) : ConsoleIntentOutcome.Applied
    }
}
