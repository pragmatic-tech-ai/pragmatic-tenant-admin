import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ComponentDescriptorBuilder, SettingType, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import { AppliedConfiguration, AppliedConfigurationCodec, AppliedConfigurationEntries, ApplyTarget, InMemoryConfigurationRepository } from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import { ComponentImageLabel, OciRegistryClient, type OciFetch, type OciRequestInit } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { ConfigurationTarget, type IComponentDescriptorSource } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ConfigMapWriteLock } from '../config-map-write-lock.js'
import { ConfigurationPreparer } from '../configuration-preparer.js'
import { ImageComponentDigests, type IRegistryClients } from '../image-component-digests.js'
import { LabelConfigurationTargets, type IConfiguredNamespaces } from '../label-configuration-targets.js'
import { FixedTargets } from './configuration-fixture.js'
import { FakeCluster } from './fake-cluster.js'

type Obj = Record<string, any>

/**
 * A registry that answers like GHCR for a public image: every read without a bearer is challenged, and its token endpoint
 * issues a pull bearer to an anonymous request (no credential). The image is an index (amd64 plus a build attestation),
 * its platform image's config carrying the component label.
 */
class PublicGhcr
{
    public static readonly Host = 'ghcr.test'
    private static readonly Bearer = 'anonymous-pull'
    private static readonly IndexType = 'application/vnd.oci.image.index.v1+json'
    private static readonly ManifestType = 'application/vnd.oci.image.manifest.v1+json'

    public readonly Requests: { url: string; authorization: string | undefined }[] = []
    private readonly blobs = new Map<string, Uint8Array>()

    /** Stores an image whose platform config carries `component` as its label; answers the index digest. */
    public Image(repo: string, component: string): string
    {
        const config = this.Store(repo, { architecture: 'amd64', os: 'linux', config: { Labels: { [ComponentImageLabel.Name]: component } } })
        const platform = this.Store(repo, { schemaVersion: 2, mediaType: PublicGhcr.ManifestType, config: { digest: config, mediaType: 'application/vnd.oci.image.config.v1+json' }, layers: [] })
        const attestationConfig = this.Store(repo, { architecture: 'unknown', os: 'unknown' })
        const attestation = this.Store(repo, { schemaVersion: 2, mediaType: PublicGhcr.ManifestType, config: { digest: attestationConfig }, layers: [] })
        return this.Store(repo, {
            schemaVersion: 2, mediaType: PublicGhcr.IndexType,
            manifests: [
                { mediaType: PublicGhcr.ManifestType, digest: platform, platform: { os: 'linux', architecture: 'amd64' } },
                { mediaType: PublicGhcr.ManifestType, digest: attestation, platform: { os: 'unknown', architecture: 'unknown' }, annotations: { 'vnd.docker.reference.type': 'attestation-manifest' } },
            ],
        })
    }

    public get Fetch(): OciFetch
    {
        return async (url: string, init: OciRequestInit) =>
        {
            const authorization = init.headers?.Authorization
            this.Requests.push({ url, authorization })
            const target = new URL(url)
            if (target.pathname === '/token')
            {
                // A public image: the pull scope is issued to anyone, without a credential.
                return new Response(JSON.stringify({ token: PublicGhcr.Bearer }), { status: 200 })
            }
            if (authorization !== 'Bearer ' + PublicGhcr.Bearer)
            {
                return new Response(null, { status: 401, headers: { 'WWW-Authenticate': `Bearer realm="https://${PublicGhcr.Host}/token",service="${PublicGhcr.Host}",scope="repository:x:pull"` } })
            }
            const digest = target.pathname.split('/').pop()!
            const bytes = this.blobs.get(digest)
            return bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 })
        }
    }

    private Store(_repo: string, value: unknown): string
    {
        const bytes = new TextEncoder().encode(JSON.stringify(value))
        const digest = OciRegistryClient.DigestOf(bytes)
        this.blobs.set(digest, bytes)
        return digest
    }
}

/** The staff realm's sign-in service on the hive after the early.13 install (live proof row 2, 2026-11-24). */
class LiveIdp
{
    public static readonly Tenant = 'pragmatic-001'
    public static readonly Idp = 'pragmatic-tenant-idp'
    public static readonly Namespace = 'pragmatic-idp-pragmatic-001'
    public static readonly Repo = 'pragmatic-tech-ai/pragmatic-tenant-idp'
    public static readonly ConfigMapPath = '/api/v1/namespaces/pragmatic-idp-pragmatic-001/configmaps/pragmatic-config-pragmatic-tenant-idp'
    public static readonly DeploymentPath = '/apis/apps/v1/namespaces/pragmatic-idp-pragmatic-001/deployments/pragmatic-idp-pragmatic-001'
    public static readonly Document = { options: { google: { clientId: 'client-1.apps.googleusercontent.com', clientSecret: 'secret:realm/google-client-secret' }, local: { maxAttempts: 5 } } }

    public static Descriptor(version: string): ComponentDescriptor
    {
        const builder = new ComponentDescriptorBuilder(LiveIdp.Idp, version)
        if (version === '0.2.0') builder.Option('core', 'The service', o => o.Setting('databaseUrl', SettingType.String, s => s.Default('postgres://localhost/idp')))
        return builder
            .Option('google', 'Google', o => o.Setting('clientId', SettingType.String, s => s.Required()).Setting('clientSecret', SettingType.String, s => s.Secret()))
            .Option('local', 'Local accounts', o => o.Setting('maxAttempts', SettingType.Integer, s => s.Default(5)))
            .Build()
    }

    public static Descriptors(): IComponentDescriptorSource
    {
        return {
            Names: () => [LiveIdp.Idp],
            Current: (component: string) => component === LiveIdp.Idp ? LiveIdp.Descriptor('0.2.6') : undefined,
            For: async () => undefined,
        }
    }

    /** The ConfigMap as the console left it on the hive: version 3 (hand-applied for 0.2.0) and the 0.2.4, 0.2.5 and 0.2.6 entries. */
    public static async Cluster(image: string): Promise<FakeCluster>
    {
        const L = LiveIdp
        const cluster = new FakeCluster()
        const applied = new AppliedConfiguration(L.Tenant, L.Idp, 3, '0.2.0', L.Descriptor('0.2.0').ContentDigest(), L.Document as never)
        cluster.Put(L.DeploymentPath, {
            apiVersion: 'apps/v1', kind: 'Deployment',
            metadata: { name: L.Namespace, namespace: L.Namespace, labels: { 'component.pragmatic-tech.ai/pragmatic-tenant-idp': 'idp', 'app.kubernetes.io/managed-by': 'pragmatic-tenant-admin' } },
            spec: { replicas: 1, template: { metadata: { annotations: AppliedConfigurationCodec.PodTemplateAnnotations(applied) }, spec: { containers: [{ name: 'idp', image }] } } },
        })
        const map = AppliedConfigurationCodec.ToConfigMap(applied, L.Namespace) as Obj
        cluster.Put(L.ConfigMapPath, map)
        // The 0.2.4 and 0.2.5 entries were prepared while the IdP ran 0.2.0, 0.2.4 and 0.2.5 (the target's digest unknown):
        // the console never dropped them, then prepared 0.2.6 beside them.
        let entries = map
        for (const [version, number] of [['0.2.4', 1], ['0.2.5', 2]] as const)
        {
            const d = L.Descriptor(version)
            entries = AppliedConfigurationEntries.With(entries as never, new AppliedConfiguration(L.Tenant, L.Idp, number, d.Version, d.ContentDigest(), L.Document as never)) as never
        }
        cluster.Put(L.ConfigMapPath, entries)
        const unknown = new FixedTargets(new Map([[L.Idp, [new ConfigurationTarget(L.Namespace, new ApplyTarget('default-mvp-hive', L.Namespace, L.Namespace), undefined, undefined)]]]))
        await new ConfigurationPreparer(new KubeApiClient(cluster), new InMemoryConfigurationRepository(), L.Descriptors(), unknown).PrepareAll(L.Tenant)
        return cluster
    }

    public static Keys(cluster: FakeCluster): string[]
    {
        return Object.keys(cluster.Objects.get(LiveIdp.ConfigMapPath)!.data).sort()
    }

    public static EntryKey(version: string): string
    {
        return 'configuration.json.sha256-' + LiveIdp.Descriptor(version).ContentDigest().slice('sha256:'.length)
    }
}

class IdpNamespace implements IConfiguredNamespaces
{
    public readonly Hive = 'default-mvp-hive'

    public async Namespaces(): Promise<readonly string[]>
    {
        return [LiveIdp.Namespace]
    }

    // The console may only get the IdP's Deployment by name there (its Role grants no list).
    public FixedDeployment(): string | undefined
    {
        return LiveIdp.Namespace
    }

    public Expected(): boolean
    {
        return true
    }
}

describe('row 2 (live proof early.13): the retired IdP entries go once the console can read what the IdP runs', () =>
{
    it('the fixture is the live ConfigMap: the applied file and the 0.2.4, 0.2.5 and 0.2.6 entries, only 0.2.6 listed prepared', async () =>
    {
        const ghcr = new PublicGhcr()
        const cluster = await LiveIdp.Cluster(`ghcr.io/${LiveIdp.Repo}@${ghcr.Image(LiveIdp.Repo, LiveIdp.Descriptor('0.2.6').ContentDigest())}`)
        assert.deepEqual(LiveIdp.Keys(cluster), ['configuration.json', LiveIdp.EntryKey('0.2.4'), LiveIdp.EntryKey('0.2.5'), LiveIdp.EntryKey('0.2.6')].sort())
        assert.equal(cluster.Objects.get(LiveIdp.ConfigMapPath)!.metadata.annotations['pragmatic-tech.ai/prepared-digests'], LiveIdp.Descriptor('0.2.6').ContentDigest())
    })

    it('reading the running image\'s label from a public registry without a credential, preparing again drops 0.2.4 and 0.2.5 and says so; the applied file stays', async () =>
    {
        const L = LiveIdp
        const ghcr = new PublicGhcr()
        const image = `${PublicGhcr.Host}/${L.Repo}@${ghcr.Image(L.Repo, L.Descriptor('0.2.6').ContentDigest())}`
        const cluster = await L.Cluster(image)
        const before = structuredClone(cluster.Objects.get(L.ConfigMapPath)!)
        const clients: IRegistryClients = { For: host => new OciRegistryClient('https://' + host, ghcr.Fetch) }
        const targets = new LabelConfigurationTargets(new KubeApiClient(cluster), new IdpNamespace(), new ImageComponentDigests(clients), { VersionOf: (_c, d) => (d === L.Descriptor('0.2.6').ContentDigest() ? '0.2.6' : undefined) })
        const [target] = await targets.For(L.Idp, L.Tenant)
        assert.equal(target!.DescriptorDigest, L.Descriptor('0.2.6').ContentDigest(), 'what the IdP runs is read')
        assert.ok(ghcr.Requests.some(r => r.url.includes('/token') && r.authorization === undefined), 'an anonymous token request, no credential sent')
        const lines: string[] = []
        await new ConfigurationPreparer(new KubeApiClient(cluster), new InMemoryConfigurationRepository(), L.Descriptors(), targets, new ConfigMapWriteLock(), line => lines.push(line)).PrepareAll(L.Tenant)
        const map = cluster.Objects.get(L.ConfigMapPath)!
        assert.deepEqual(LiveIdp.Keys(cluster), ['configuration.json', L.EntryKey('0.2.6')].sort())
        assert.equal(map.data['configuration.json'], before.data['configuration.json'], 'the running file is untouched')
        assert.equal(map.metadata.annotations['pragmatic-tech.ai/configuration-hash'], before.metadata.annotations['pragmatic-tech.ai/configuration-hash'])
        assert.equal(map.metadata.annotations['pragmatic-tech.ai/prepared-digests'], L.Descriptor('0.2.6').ContentDigest())
        assert.deepEqual(lines, [`[configuration] ${L.Idp} on ${L.Namespace}: dropped the entries prepared for 0.2.4, 0.2.5 (neither the release's nor what runs there)`])
    })

    it('after an apply or a revert the target is looked up, so what it runs is known and the retired entries go then too', async () =>
    {
        const L = LiveIdp
        const ghcr = new PublicGhcr()
        const cluster = await L.Cluster(`${PublicGhcr.Host}/${L.Repo}@${ghcr.Image(L.Repo, L.Descriptor('0.2.6').ContentDigest())}`)
        const clients: IRegistryClients = { For: host => new OciRegistryClient('https://' + host, ghcr.Fetch) }
        const targets = new LabelConfigurationTargets(new KubeApiClient(cluster), new IdpNamespace(), new ImageComponentDigests(clients), { VersionOf: () => undefined })
        const preparer = new ConfigurationPreparer(new KubeApiClient(cluster), new InMemoryConfigurationRepository(), L.Descriptors(), targets)
        const applied = AppliedConfigurationCodec.FromConfigMap(cluster.Objects.get(L.ConfigMapPath)!)
        await preparer.PrepareApplied(applied, new ApplyTarget('default-mvp-hive', L.Namespace, L.Namespace))
        assert.deepEqual(LiveIdp.Keys(cluster), ['configuration.json', L.EntryKey('0.2.6')].sort())
    })
})
