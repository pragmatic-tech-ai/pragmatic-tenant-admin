import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import { K8sManifestBuilder } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { LabelConfigurationTargets, type IConfiguredNamespaces, type IImageComponentDigests } from '../label-configuration-targets.js'
import { ConfigurationFixture as F } from './configuration-fixture.js'
import { FakeCluster } from './fake-cluster.js'

class Namespaces implements IConfiguredNamespaces
{
    public readonly Hive = 'h1'

    public async Namespaces(): Promise<readonly string[]>
    {
        return ['pragmatic-system', 'pragmatic-env-dev1', 'pragmatic-env-dev2', 'pragmatic-env-locked']
    }

    // The hive's own components have one Deployment each in pragmatic-system.
    public FixedDeployment(component: string, namespace: string): string | undefined
    {
        return namespace === 'pragmatic-system' && component === 'pragmatic-hive-agent' ? 'pragmatic-hive-agent-h1' : undefined
    }

    // Every name the test cluster renders, never the impostor.
    public Expected(_component: string, _namespace: string, deployment: string): boolean
    {
        return deployment !== 'impostor'
    }
}

class Images implements IImageComponentDigests
{
    public constructor(private readonly digests: Record<string, string>)
    {
    }

    public async DigestOf(image: string): Promise<string | undefined>
    {
        return this.digests[image]
    }
}

class TargetsWorld
{
    public static Deployment(namespace: string, name: string, labels: Record<string, string>, containers: Record<string, string>, init: Record<string, string> = {}): Record<string, unknown>
    {
        const list = (m: Record<string, string>): unknown[] => Object.entries(m).map(([n, image]) => ({ name: n, image }))
        return {
            apiVersion: 'apps/v1', kind: 'Deployment',
            metadata: { name, namespace, labels: { 'app.kubernetes.io/managed-by': 'pragmatic-tenant-admin', ...labels } },
            spec: { replicas: 1, template: { metadata: {}, spec: { containers: list(containers), initContainers: list(init) } } },
        }
    }

    public static Cluster(): FakeCluster
    {
        const W = TargetsWorld
        const cluster = new FakeCluster()
        cluster.Put('/apis/apps/v1/namespaces/pragmatic-system/deployments/pragmatic-hive-agent-h1',
            W.Deployment('pragmatic-system', 'pragmatic-hive-agent-h1', { 'component.pragmatic-tech.ai/pragmatic-hive-agent': 'agent' }, { agent: 'ghcr.io/x/agent@sha256:' + 'a'.repeat(64) }))
        for (const env of ['dev1', 'dev2'])
        {
            cluster.Put(`/apis/apps/v1/namespaces/pragmatic-env-${env}/deployments/pragmatic-env-${env}-server`, W.Deployment(`pragmatic-env-${env}`, `pragmatic-env-${env}-server`,
                { 'pragmatic/environment': env, 'component.pragmatic-tech.ai/pragmatic-env-server': 'server', 'component.pragmatic-tech.ai/pragmatic-ui-unpack': 'ui-unpack' },
                { server: `server:${env}` }, { 'ui-unpack': 'ui-unpack:dev' }))
        }
        // Not the console's: no managed-by label.
        cluster.Put('/apis/apps/v1/namespaces/pragmatic-env-dev2/deployments/other', { ...W.Deployment('pragmatic-env-dev2', 'other', {}, { server: 'x' }), metadata: { name: 'other', labels: { 'component.pragmatic-tech.ai/pragmatic-env-server': 'server' } } })
        // Carries every label, but is not the Deployment the console's manifests render there.
        cluster.Put('/apis/apps/v1/namespaces/pragmatic-env-dev1/deployments/impostor', W.Deployment('pragmatic-env-dev1', 'impostor',
            { 'pragmatic/environment': 'dev1', 'component.pragmatic-tech.ai/pragmatic-env-server': 'server' }, { server: 'evil:1' }))
        cluster.Refusals.set('GET /apis/apps/v1/namespaces/pragmatic-env-locked/deployments', 403)
        return cluster
    }
}

describe('LabelConfigurationTargets', () =>
{
    it('lists a target for every labelled deployment of the component, in every namespace the console manages', async () =>
    {
        const cluster = TargetsWorld.Cluster()
        const targets = new LabelConfigurationTargets(new KubeApiClient(cluster), new Namespaces(), new Images({}), { VersionOf: () => undefined })
        const servers = await targets.For(F.Server, F.Tenant)
        assert.deepEqual(servers.map(t => [t.Name, t.Target.Namespace, t.Target.Deployment]), [
            ['dev1', 'pragmatic-env-dev1', 'pragmatic-env-dev1-server'], ['dev2', 'pragmatic-env-dev2', 'pragmatic-env-dev2-server'],
        ])
        assert.deepEqual((await targets.For('pragmatic-ui-unpack', F.Tenant)).map(t => t.Name), ['dev1', 'dev2'], 'an init container is a target of its own component')
        assert.deepEqual((await targets.For(F.Agent, F.Tenant)).map(t => [t.Name, t.Target.Hive]), [['pragmatic-system', 'h1']], 'a hive component is shown by its namespace')
        assert.deepEqual(await targets.For('pragmatic-tenant-idp', F.Tenant), [])
        const selector = cluster.Calls.find(c => c.path.includes('labelSelector'))!.path
        assert.ok(decodeURIComponent(selector).includes('app.kubernetes.io/managed-by=pragmatic-tenant-admin'))
        assert.ok(K8sManifestBuilder.SystemNamespace === 'pragmatic-system')
    })

    it('finds a hive component by its Deployment name where the console may only get it, never list the namespace', async () =>
    {
        const cluster = TargetsWorld.Cluster()
        cluster.Refusals.set('GET /apis/apps/v1/namespaces/pragmatic-system/deployments', 403)
        const targets = new LabelConfigurationTargets(new KubeApiClient(cluster), new Namespaces(), new Images({}), { VersionOf: () => undefined })
        assert.deepEqual((await targets.For(F.Agent, F.Tenant)).map(t => [t.Name, t.Target.Deployment]), [['pragmatic-system', 'pragmatic-hive-agent-h1']])
        assert.ok(!cluster.Calls.some(c => c.path.startsWith('/apis/apps/v1/namespaces/pragmatic-system/deployments?')), 'the namespace is never listed')
    })

    it('finds nothing for a hive component whose Deployment is absent or is not labelled for the component', async () =>
    {
        const cluster = TargetsWorld.Cluster()
        const targets = new LabelConfigurationTargets(new KubeApiClient(cluster), new Namespaces(), new Images({}), { VersionOf: () => undefined })
        assert.deepEqual(await targets.For('pragmatic-tenant-admin', F.Tenant), [])
    })

    it('shows two targets that would share a name by their namespaces', async () =>
    {
        const cluster = TargetsWorld.Cluster()
        cluster.Put('/apis/apps/v1/namespaces/pragmatic-env-dev2/deployments/pragmatic-env-dev2-server', TargetsWorld.Deployment('pragmatic-env-dev2', 'pragmatic-env-dev2-server',
            { 'pragmatic/environment': 'dev1', 'component.pragmatic-tech.ai/pragmatic-env-server': 'server' }, { server: 'server:dev2' }))
        const targets = new LabelConfigurationTargets(new KubeApiClient(cluster), new Namespaces(), new Images({}), { VersionOf: () => undefined })
        assert.deepEqual((await targets.For(F.Server, F.Tenant)).map(t => t.Name), ['pragmatic-env-dev1', 'pragmatic-env-dev2'])
    })

    it('carries the descriptor digest and version of the image the component\'s container runs', async () =>
    {
        const digest = F.Agent010().ContentDigest()
        const images = new Images({ ['ghcr.io/x/agent@sha256:' + 'a'.repeat(64)]: digest })
        const targets = new LabelConfigurationTargets(new KubeApiClient(TargetsWorld.Cluster()), new Namespaces(), images, { VersionOf: (c, d) => (c === F.Agent && d === digest ? '0.1.0' : undefined) })
        const [agent] = await targets.For(F.Agent, F.Tenant)
        assert.deepEqual([agent.DescriptorDigest, agent.ComponentVersion], [digest, '0.1.0'])
        const [server] = await targets.For(F.Server, F.Tenant)
        assert.deepEqual([server.DescriptorDigest, server.ComponentVersion], [undefined, undefined], 'a tagged development image has no known digest')
    })
})
