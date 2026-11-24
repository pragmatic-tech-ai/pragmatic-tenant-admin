import type { SecretReference } from '@pragmatic-tech-ai/pragmatic-component'
import type { ApplyTarget, RealmSecretWriter } from '@pragmatic-tech-ai/pragmatic-configuration'
import { RealmSecretName } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import type { IComponentSecretWriter } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

/**
 * Writes a secret value a tenant admin enters into the realm's secrets home (2.5), through the console's
 * `RealmSecretWriter`: the configuration then holds `secret:realm/<name>`. A realm secret is the realm's, one value per
 * name for every target of every component (the C3.1 interim `file` store kept one per target namespace); the target is
 * the service's own check. Names are one lowercase segment, which `AcceptsName` tells the service before it writes.
 */
export class RealmComponentSecretWriter implements IComponentSecretWriter
{
    public constructor(private readonly writer: RealmSecretWriter)
    {
    }

    public AcceptsName(name: string): boolean
    {
        return RealmSecretName.IsName(name)
    }

    public Put(_component: string, name: string, value: string, _targets: readonly ApplyTarget[]): Promise<SecretReference>
    {
        return this.writer.Put(name, value)
    }
}
