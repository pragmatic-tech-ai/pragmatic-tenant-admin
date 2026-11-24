import type { ApplyTarget } from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeResourceCatalog, type KubeApiClient, type KubeTypeRef } from '@pragmatic-tech-ai/pragmatic-kube'
import { RealmSecretsSettings } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { ComponentConfigurationMounts } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

/** Whether a target's workload is given the realm secrets home's settings (its component's container names the option). */
export interface IRealmHomeWorkloads
{
    Gives(component: string, target: ApplyTarget): Promise<boolean>
}

type ContainerShape = { name?: unknown; env?: Array<{ name?: unknown }> }
type DeploymentShape = {
    metadata?: { labels?: Record<string, unknown> }
    spec?: { template?: { spec?: { containers?: ContainerShape[]; initContainers?: ContainerShape[] } } }
}

/**
 * Reads the target's Deployment: its component's container must carry `PRAGMATIC_REALM_SECRETS_OPTION`. A version that
 * reads the realm home (RealmCapableComponents) is not enough: an environment's Deployment rendered before its console had
 * the home, then rolled to a newer server image, runs a capable version without the home's settings, and a configuration
 * holding `secret:realm/...` would refuse its start. A missing Deployment is not given; one that cannot be read (the API
 * refused or failed) is not given either, and logged by name.
 */
export class KubeRealmHomeWorkloads implements IRealmHomeWorkloads
{
    private static readonly DeploymentType: KubeTypeRef = { apiVersion: 'apps/v1', kind: 'Deployment' }

    private static readonly Unread = 'realm secrets: the workload of a target could not be read, so it keeps its interim secrets: '
    private static readonly Separator = '/'
    private static readonly UnknownError = 'Error'

    public constructor(private readonly client: KubeApiClient, private readonly log: (line: string) => void)
    {
    }

    public async Gives(component: string, target: ApplyTarget): Promise<boolean>
    {
        const K = KubeRealmHomeWorkloads
        let deployment: DeploymentShape | undefined
        try
        {
            deployment = await this.client.Get(KubeResourceCatalog.PathOf(K.DeploymentType, target.Namespace, target.Deployment)) as DeploymentShape | undefined
        }
        catch (error)
        {
            // Not a missing Deployment (that reads undefined): the API refused or failed. Not given, and said once per check.
            this.log(K.Unread + target.Namespace + K.Separator + target.Deployment + K.Separator + (error instanceof Error ? error.name : K.UnknownError))
            return false
        }
        const wanted = ComponentConfigurationMounts.ContainerOf(deployment?.metadata?.labels, component)
        const pod = deployment?.spec?.template?.spec
        const container = [...(pod?.containers ?? []), ...(pod?.initContainers ?? [])].find(c => c.name === wanted)
        return (container?.env ?? []).some(variable => variable.name === RealmSecretsSettings.OptionVariable)
    }
}

/** Every workload is given the home (tests of the version rules alone). */
export class EveryRealmHomeWorkload implements IRealmHomeWorkloads
{
    public Gives(): Promise<boolean>
    {
        return Promise.resolve(true)
    }
}
