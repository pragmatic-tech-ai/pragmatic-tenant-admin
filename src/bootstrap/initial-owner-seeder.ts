import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IdpAdminClient, TenantOwner, type IIdpService, type TenantRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

/** Waits between two seeding attempts. */
export interface ISeedWait
{
    Wait(ms: number): Promise<void>
}

export class TimerSeedWait implements ISeedWait
{
    public Wait(ms: number): Promise<void>
    {
        return new Promise<void>(resolve => setTimeout(resolve, ms))
    }
}

/** The realm calls the seeder makes (IdpAdminClient in the pod; a recorder in tests). */
export interface IOwnerRealm
{
    EnsureRealm(tenantId: string, displayName: string): Promise<void>
    SeedAccount(tenantId: string, account: { email: string; principalId: string; displayName: string; password: string }): Promise<void>
}

/**
 * A chart-installed engine's first local admin: the realm (named by the tenant id, from the first start, so enrolment never
 * renames it) and its Owner account with the one-time password the bootstrap minted into `pragmatic-owner-initial`
 * (read with `kubectl get secret pragmatic-owner-initial`). The realm sign-in service keeps an existing principal's
 * password, so seeding again at every start never resets a password the Owner changed. Retried in the background until
 * the sign-in service answers; the log names steps, never the email or the password.
 */
export class InitialOwnerSeeder
{
    public static readonly EmailFile = 'email'
    public static readonly PasswordFile = 'password'
    public static readonly RetryMs = 5000
    private static readonly Utf8 = 'utf8'
    private static readonly SeededLine = '[owner] the realm and its Owner are seeded'
    private static readonly RetryPrefix = '[owner] seeding the Owner failed, retrying: '
    private static readonly UnreadableLine = '[owner] the one-time Owner sign-in is unreadable; nothing seeded'

    private stopped = false

    public constructor(
        private readonly tenant: TenantRecord,
        private readonly directory: string,
        private readonly realm: () => Promise<IOwnerRealm>,
        private readonly log: (line: string) => void,
        private readonly wait: ISeedWait = new TimerSeedWait())
    {
    }

    /** The seeder over the console's injected sign-in service (its admin token and CA). */
    public static Over(idp: IIdpService, tenant: TenantRecord, directory: string, log: (line: string) => void): InitialOwnerSeeder
    {
        return new InitialOwnerSeeder(tenant, directory, async () => new IdpAdminClient(await idp.EnsureForTenant(tenant.id, tenant.displayName)), log)
    }

    /** Seeds once it can; resolves when seeded, unreadable or stopped. */
    public async Run(): Promise<void>
    {
        const S = InitialOwnerSeeder
        const sign = this.ReadSignIn()
        if (sign === undefined)
        {
            this.log(S.UnreadableLine)
            return
        }
        while (!this.stopped)
        {
            try
            {
                const realm = await this.realm()
                await realm.EnsureRealm(this.tenant.id, this.tenant.displayName)
                await realm.SeedAccount(this.tenant.id, {
                    email: sign.email,
                    principalId: TenantOwner.PrincipalOf(this.tenant),
                    displayName: this.tenant.displayName,
                    password: sign.password,
                })
                this.log(S.SeededLine)
                return
            }
            catch (error)
            {
                this.log(S.RetryPrefix + (error instanceof Error ? error.name : typeof error))
                await this.wait.Wait(S.RetryMs)
            }
        }
    }

    public Stop(): void
    {
        this.stopped = true
    }

    private ReadSignIn(): { email: string; password: string } | undefined
    {
        const S = InitialOwnerSeeder
        try
        {
            const email = readFileSync(join(this.directory, S.EmailFile), S.Utf8).trim()
            const password = readFileSync(join(this.directory, S.PasswordFile), S.Utf8).trim()
            return email === '' || password === '' ? undefined : { email, password }
        }
        catch
        {
            return undefined
        }
    }
}
