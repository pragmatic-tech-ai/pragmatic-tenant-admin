import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApplyTarget } from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeApiClient, KubeContentType } from '@pragmatic-tech-ai/pragmatic-kube'
import { K8sManifestBuilder } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ConfigurationReaders } from '../configuration-readers.js'
import { ConsoleConfiguredNamespaces } from '../console-configuration.js'
import { LabelConfigurationTargets, type IConfiguredNamespaces } from '../label-configuration-targets.js'
import { ReleaseDescriptorCatalogue } from '../release-descriptor-catalogue.js'
import { RolloutState, RolloutWatch } from '../rollout-watch.js'
import { FakeClock, FakeCluster } from './fake-cluster.js'

type Obj = Record<string, any>

class ReadersWorld
{
    public static readonly AgentPath = '/apis/apps/v1/namespaces/pragmatic-system/deployments/pragmatic-hive-agent-h1'
    public static readonly ServerPath = '/apis/apps/v1/namespaces/pragmatic-env-dev1/deployments/pragmatic-env-dev1-server'
    public static readonly AgentImage = 'ghcr.io/x/agent@sha256:' + 'a'.repeat(64)
    public static readonly ServerImage = 'ghcr.io/x/server@sha256:' + 'b'.repeat(64)

    public static Deployment(name: string, namespace: string, labels: Record<string, string>, container: string, image: string): Obj
    {
        return {
            apiVersion: 'apps/v1', kind: 'Deployment',
            metadata: { name, namespace, labels: { 'app.kubernetes.io/managed-by': 'pragmatic-tenant-admin', ...labels } },
            spec: { replicas: 1, template: { metadata: {}, spec: { containers: [{ name: container, image }] } } },
        }
    }

    public static Namespaces(): IConfiguredNamespaces
    {
        return {
            Hive: 'h1',
            Namespaces: async () => ['pragmatic-system', 'pragmatic-env-dev1'],
            FixedDeployment: (component: string, namespace: string) => namespace === 'pragmatic-system' && component === 'pragmatic-hive-agent' ? 'pragmatic-hive-agent-h1' : undefined,
            Expected: () => true,
        }
    }
}

describe('ConfigurationReaders (I3: images from before the start step read no configuration)', () =>
{
    it('knows the first version of each hive component that reads its configuration at start', () =>
    {
        assert.equal(ConfigurationReaders.Reads('pragmatic-hive-agent', '0.1.0'), false)
        assert.equal(ConfigurationReaders.Reads('pragmatic-hive-agent', '0.1.1'), true)
        assert.equal(ConfigurationReaders.Reads('pragmatic-hive-agent', '0.1.2'), true)
        assert.equal(ConfigurationReaders.Reads('pragmatic-env-gateway', '0.1.0'), false)
        assert.equal(ConfigurationReaders.Reads('pragmatic-tenant-idp', '0.2.0'), false)
        assert.equal(ConfigurationReaders.Reads('pragmatic-tenant-idp', '0.2.6'), true)
        assert.equal(ConfigurationReaders.Reads('pragmatic-tenant-admin', '0.1.4'), true)
        assert.equal(ConfigurationReaders.Reads('pragmatic-env-server', '0.1.0'), false)
        assert.equal(ConfigurationReaders.Reads('pragmatic-env-server', '0.1.1'), false, 'the env server on Postgres, still without its start step')
        assert.equal(ConfigurationReaders.Reads('pragmatic-env-server', '0.1.2'), true)
        assert.equal(ConfigurationReaders.Reads('pragmatic-env-server', undefined), true, 'a version not known is taken to read it (unverified target)')
    })

    it('a target whose image runs a version that reads no configuration says so; one of a reading version or an unknown one reads it', async () =>
    {
        const W = ReadersWorld
        const cluster = new FakeCluster()
        cluster.Put(W.AgentPath, W.Deployment('pragmatic-hive-agent-h1', 'pragmatic-system', { 'component.pragmatic-tech.ai/pragmatic-hive-agent': 'agent' }, 'agent', W.AgentImage))
        cluster.Put(W.ServerPath, W.Deployment('pragmatic-env-dev1-server', 'pragmatic-env-dev1', { 'pragmatic/environment': 'dev1', 'component.pragmatic-tech.ai/pragmatic-env-server': 'server' }, 'server', W.ServerImage))
        const images = { DigestOf: async (image: string) => (image === W.AgentImage ? 'sha256:agent' : image === W.ServerImage ? 'sha256:server' : undefined) }
        const versions = { VersionOf: (_c: string, digest: string) => (digest === 'sha256:agent' ? '0.1.0' : digest === 'sha256:server' ? '0.1.0' : undefined) }
        const targets = new LabelConfigurationTargets(new KubeApiClient(cluster), W.Namespaces(), images, versions)
        const [agent] = await targets.For('pragmatic-hive-agent', 'acme')
        assert.deepEqual([agent.ComponentVersion, agent.ReadsConfiguration], ['0.1.0', false])
        const [server] = await targets.For('pragmatic-env-server', 'acme')
        assert.equal(server.ReadsConfiguration, false)
        const unknown = new LabelConfigurationTargets(new KubeApiClient(cluster), W.Namespaces(), images, { VersionOf: () => undefined })
        assert.equal((await unknown.For('pragmatic-hive-agent', 'acme'))[0].ReadsConfiguration, true)
        const newer = new LabelConfigurationTargets(new KubeApiClient(cluster), W.Namespaces(), images, { VersionOf: () => '0.1.2' })
        assert.equal((await newer.For('pragmatic-hive-agent', 'acme'))[0].ReadsConfiguration, true)
    })
})

describe('the UI unpacker is not configured (I4: its settings are per-environment deployment wiring)', () =>
{
    it('is not a component the console configures, and no Deployment is its target', () =>
    {
        assert.ok(!ReleaseDescriptorCatalogue.HiveComponents.includes('pragmatic-ui-unpack'))
        const namespaces = new ConsoleConfiguredNamespaces('h1', 'acme', { List: () => [] })
        const namespace = K8sManifestBuilder.NamespaceOf('dev1')
        assert.equal(namespaces.Expected('pragmatic-ui-unpack', namespace, K8sManifestBuilder.ServerDeploymentOf('dev1'), 'dev1'), false)
        assert.equal(namespaces.Expected('pragmatic-env-server', namespace, K8sManifestBuilder.ServerDeploymentOf('dev1'), 'dev1'), true, 'the env server there still is')
    })
})

describe('RolloutWatch over minReadySeconds (I5)', () =>
{
    it('a surge pod ready for a moment before it exits is not taken for a finished roll', async () =>
    {
        const path = '/apis/apps/v1/namespaces/pragmatic-system/deployments/agent'
        const clock = new FakeClock()
        const cluster = new FakeCluster()
        cluster.Clock = clock
        cluster.Put(path, { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'agent', namespace: 'pragmatic-system' }, spec: { replicas: 1, minReadySeconds: 10, template: { metadata: { annotations: { v: '1' } }, spec: { containers: [{ name: 'agent' }] } } } })
        // The new pod reads its settings, is ready for a second, then exits 78 (a refused configuration).
        cluster.Readies = template => template.metadata.annotations.v === '1' || clock.Now() < 1000
        const client = new KubeApiClient(cluster)
        await client.Patch(path, { spec: { template: { metadata: { annotations: { v: '2' } } } } }, KubeContentType.StrategicMerge)
        assert.equal(await new RolloutWatch(client, clock).Await(new ApplyTarget('h1', 'pragmatic-system', 'agent'), 30_000), RolloutState.NotReady)
        assert.equal(cluster.Outages.length, 0, 'the old pod kept serving')
    })

    it('a surge pod that stays ready past minReadySeconds finishes the roll', async () =>
    {
        const path = '/apis/apps/v1/namespaces/pragmatic-system/deployments/agent'
        const clock = new FakeClock()
        const cluster = new FakeCluster()
        cluster.Clock = clock
        cluster.Put(path, { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'agent', namespace: 'pragmatic-system' }, spec: { replicas: 1, minReadySeconds: 10, template: { metadata: { annotations: { v: '1' } }, spec: { containers: [{ name: 'agent' }] } } } })
        const client = new KubeApiClient(cluster)
        await client.Patch(path, { spec: { template: { metadata: { annotations: { v: '2' } } } } }, KubeContentType.StrategicMerge)
        assert.equal(await new RolloutWatch(client, clock).Await(new ApplyTarget('h1', 'pragmatic-system', 'agent'), 30_000), RolloutState.Ready)
        assert.ok(clock.Now() >= 10_000, 'not before minReadySeconds')
    })
})
