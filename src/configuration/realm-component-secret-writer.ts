import type { SecretReference } from '@pragmatic-tech-ai/pragmatic-component'
import type { ApplyTarget, RealmSecretWriter } from '@pragmatic-tech-ai/pragmatic-configuration'
import { RealmSecretName } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import type { IComponentSecretWriter, IConfigurationTargetSource } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { RealmCapableComponents } from './realm-capable-components.js'

/**
 * Writes a secret value a tenant admin enters into the realm's secrets home (2.5), through the console's
 * `RealmSecretWriter`: the configuration then holds `secret:realm/<name>`. A realm secret is the realm's, one value per
 * name for every target of every component (the C3.1 interim `file` store kept one per target namespace). Where the
 * realm home cannot serve the write, it goes to the interim `file` store as before, answering `secret:file/<name>`:
 * a target runs a version that cannot read the realm home yet (RealmCapableComponents), or the name is not a realm
 * secret name (one lowercase segment).
 */
export class RealmComponentSecretWriter implements IComponentSecretWriter
{
    public constructor(
        private readonly writer: RealmSecretWriter,
        private readonly interim: IComponentSecretWriter,
        private readonly targets: IConfigurationTargetSource,
        private readonly tenantId: string)
    {
    }

    public async Put(component: string, name: string, value: string, targets: readonly ApplyTarget[]): Promise<SecretReference>
    {
        if (RealmSecretName.IsName(name) && await this.Reads(component, targets)) return this.writer.Put(name, value)
        return this.interim.Put(component, name, value, targets)
    }

    // Whether every given target runs a version that reads the realm home.
    private async Reads(component: string, targets: readonly ApplyTarget[]): Promise<boolean>
    {
        const known = await this.targets.For(component, this.tenantId)
        return targets.length > 0 && targets.every(target =>
        {
            const found = known.find(entry => entry.Target.Equals(target))
            return found !== undefined && RealmCapableComponents.Reads(component, found.ComponentVersion)
        })
    }
}
