import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KubeContentType, KubeMethod, type IKubeTransport, type KubeResponse } from '@pragmatic-tech-ai/pragmatic-kube'
import { BootstrapCli, type IBootstrapOutput } from '../bootstrap-cli.js'
import { BootstrapSettings } from '../bootstrap-settings.js'
import { EngineBootstrap, type IRandomSource } from '../engine-bootstrap.js'
import { EngineSecretOrigin, EngineSecretScope, EngineSecretSet } from '../engine-secret-set.js'
import type { ITlsMinter, LeafMaterial, TlsMaterial } from '../tls-minter.js'
import { KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'

type Obj = { metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> }; type?: string; data?: Record<string, string> }

/** Namespaces and Secrets in memory: GET by path, POST creates (409 when present), apply-PATCH replaces. */
class MemoryCluster implements IKubeTransport
{
    public readonly Objects = new Map<string, Obj>()
    public readonly Writes: string[] = []

    public async Send(method: KubeMethod, path: string, body: string | undefined, _type: KubeContentType): Promise<KubeResponse>
    {
        const bare = path.split('?')[0]
        if (method === KubeMethod.Get)
        {
            const found = this.Objects.get(bare)
            return found === undefined ? { status: 404, body: '{}' } : { status: 200, body: JSON.stringify(found) }
        }
        const object = JSON.parse(body ?? '{}') as Obj
        if (method === KubeMethod.Post)
        {
            const at = bare + '/' + object.metadata.name
            if (this.Objects.has(at))
            {
                return { status: 409, body: '{}' }
            }
            this.Writes.push('create ' + at)
            this.Objects.set(at, object)
            return { status: 201, body: '{}' }
        }
        if (_type === KubeContentType.MergePatch)
        {
            const current = this.Objects.get(bare)
            if (current === undefined)
            {
                return { status: 404, body: '{}' }
            }
            this.Writes.push('patch ' + bare)
            current.metadata.labels = { ...(current.metadata.labels ?? {}), ...(object.metadata.labels ?? {}) }
            return { status: 200, body: '{}' }
        }
        this.Writes.push('apply ' + bare)
        this.Objects.set(bare, object)
        return { status: 200, body: '{}' }
    }

    public Secret(namespace: string, name: string): Obj | undefined
    {
        return this.Objects.get('/api/v1/namespaces/' + namespace + '/secrets/' + name)
    }

    public Snapshot(): string
    {
        return JSON.stringify([...this.Objects.entries()].sort())
    }
}

/** Counts up, so every minted value differs and is recognisable in a scan. */
class CountingRandom implements IRandomSource
{
    private next = 1

    public Bytes(count: number): Buffer
    {
        const bytes = Buffer.alloc(count)
        bytes.writeUInt32BE(this.next++, 0)
        bytes.fill(0x5a, 4)
        return bytes
    }
}

class RecordingMinter implements ITlsMinter
{
    public readonly Minted: string[][] = []

    public Mint(hosts: readonly string[]): TlsMaterial
    {
        this.Minted.push([...hosts])
        const n = this.Minted.length
        return { Ca: Buffer.from('ca-' + n), Cert: Buffer.from('cert-' + n), Key: Buffer.from('key-' + n), CaKey: Buffer.from('ca-key-' + n) }
    }

    public MintLeaf(hosts: readonly string[]): LeafMaterial
    {
        this.Minted.push([...hosts])
        return { Cert: Buffer.from('leaf-' + this.Minted.length), Key: Buffer.from('leaf-key-' + this.Minted.length) }
    }
}

class RecordingOutput implements IBootstrapOutput
{
    public readonly Lines: string[] = []

    public Line(text: string): void
    {
        this.Lines.push(text)
    }
}

class BootstrapFixture
{
    public static readonly Namespace = 'pragmatic-system'
    public static readonly IdpNamespace = 'pragmatic-idp-acme'

    public static Env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv
    {
        return {
            PRAGMATIC_BOOTSTRAP_NAMESPACE: BootstrapFixture.Namespace,
            PRAGMATIC_BOOTSTRAP_IDP_NAMESPACE: BootstrapFixture.IdpNamespace,
            PRAGMATIC_BOOTSTRAP_TENANT_ID: 'acme',
            PRAGMATIC_BOOTSTRAP_HIVE_ID: 'acme-hive',
            PRAGMATIC_BOOTSTRAP_CONSOLE_HOST: 'console.acme.example',
            PRAGMATIC_BOOTSTRAP_BASE_DOMAIN: 'acme.example',
            PRAGMATIC_BOOTSTRAP_IDP_HOST: 'idp-acme.acme.example',
            PRAGMATIC_BOOTSTRAP_IDP_INTERNAL_HOST: 'pragmatic-idp-acme.pragmatic-idp-acme.svc.cluster.local',
            PRAGMATIC_BOOTSTRAP_TLS_MODE: 'self-signed',
            PRAGMATIC_BOOTSTRAP_OWNER_EMAIL: 'owner@acme.example',
            ...overrides,
        }
    }

    public static async Run(cluster: MemoryCluster, env: NodeJS.ProcessEnv = BootstrapFixture.Env(), minter: ITlsMinter = new RecordingMinter())
    {
        return await new EngineBootstrap(new KubeApiClient(cluster), BootstrapSettings.From(env), minter, new CountingRandom(), () => new Date('2026-11-24T00:00:00Z')).Run()
    }

    public static NamespaceOf(scope: EngineSecretScope): string
    {
        return scope === EngineSecretScope.Idp ? BootstrapFixture.IdpNamespace : BootstrapFixture.Namespace
    }

    public static Decoded(object: Obj | undefined, key: string): string
    {
        return Buffer.from(object?.data?.[key] ?? '', 'base64').toString('utf8')
    }
}

describe('EngineBootstrap', () =>
{
    it('mints every secret on an empty namespace, with keep and the engine label, and creates the IdP namespace', async () =>
    {
        const cluster = new MemoryCluster()
        const report = await BootstrapFixture.Run(cluster)
        assert.ok(cluster.Objects.has('/api/v1/namespaces/' + BootstrapFixture.IdpNamespace))
        for (const spec of EngineSecretSet.Specs(true))
        {
            const secret = cluster.Secret(BootstrapFixture.NamespaceOf(spec.Scope), spec.Name)
            assert.ok(secret !== undefined, spec.Name)
            assert.deepEqual(Object.keys(secret.data ?? {}).sort(), [...spec.Keys].sort(), spec.Name)
            assert.equal(secret.type, spec.Type, spec.Name)
            assert.equal(secret.metadata.annotations?.['helm.sh/resource-policy'], 'keep', spec.Name)
            assert.equal(secret.metadata.labels?.['app.kubernetes.io/managed-by'], 'pragmatic-engine', spec.Name)
        }
        assert.equal(report.Kept.length, 0)
        for (const [namespace, component] of [['pragmatic-system', 'pragmatic-tenant-admin'], ['pragmatic-system', 'pragmatic-hive-agent'], [BootstrapFixture.IdpNamespace, 'pragmatic-tenant-idp']])
        {
            const map = cluster.Objects.get('/api/v1/namespaces/' + namespace + '/configmaps/pragmatic-config-' + component)
            assert.equal(map?.metadata.labels?.['app.kubernetes.io/component'], component)
            assert.equal(map?.metadata.labels?.['app.kubernetes.io/managed-by'], 'pragmatic-tenant-admin')
            assert.ok(cluster.Secret(namespace, 'pragmatic-secrets-' + component), component)
        }
        const superuser = cluster.Secret(BootstrapFixture.Namespace, EngineSecretSet.PostgresSuperuser)
        assert.equal(BootstrapFixture.Decoded(superuser, 'database-url'), 'postgres://postgres:' + BootstrapFixture.Decoded(superuser, 'password') + '@pragmatic-postgres.pragmatic-system.svc:5432/postgres')
        const idp = cluster.Secret(BootstrapFixture.Namespace, EngineSecretSet.PostgresTenantIdp)
        assert.equal(BootstrapFixture.Decoded(cluster.Secret(BootstrapFixture.IdpNamespace, EngineSecretSet.IdpDatabase), 'database-url'), BootstrapFixture.Decoded(idp, 'database-url'))
        assert.equal(BootstrapFixture.Decoded(cluster.Secret(BootstrapFixture.Namespace, EngineSecretSet.IdpCa), 'ca.crt'), BootstrapFixture.Decoded(cluster.Secret(BootstrapFixture.IdpNamespace, EngineSecretSet.IdpTls), 'ca.crt'))
        assert.equal(BootstrapFixture.Decoded(cluster.Secret(BootstrapFixture.Namespace, EngineSecretSet.OwnerInitial), 'email'), 'owner@acme.example')
        assert.match(BootstrapFixture.Decoded(cluster.Secret(BootstrapFixture.IdpNamespace, EngineSecretSet.IdpSigningKey), 'signing-key.pem'), /^-----BEGIN PRIVATE KEY-----/)
        const seed = JSON.parse(BootstrapFixture.Decoded(cluster.Secret(BootstrapFixture.Namespace, EngineSecretSet.TenantAdminSeed), 'seed.json'))
        assert.equal(seed.tenant.id, 'acme')
        assert.equal(seed.tenant.ownerEmail, 'owner@acme.example')
        assert.equal(seed.hives[0].id, 'acme-hive')
        assert.deepEqual(seed.hives[0].cluster, { backend: 'local', mode: 'attach' }, 'the in-cluster orchestrator takes only a local attached hive')
        assert.equal(Buffer.from(cluster.Secret(BootstrapFixture.Namespace, EngineSecretSet.TenantAdminMasterKey)?.data?.['master.key'] ?? '', 'base64').length, 32)
    })

    it('mints the custom realm secrets home: the realm master key (copied for the sign-in service) and its three roles on realm_secrets', async () =>
    {
        const cluster = new MemoryCluster()
        await BootstrapFixture.Run(cluster)
        const key = cluster.Secret(BootstrapFixture.Namespace, EngineSecretSet.RealmMasterKey)?.data?.['master.key'] ?? ''
        assert.equal(Buffer.from(key, 'base64').length, 32)
        assert.equal(cluster.Secret(BootstrapFixture.IdpNamespace, EngineSecretSet.RealmMasterKey)?.data?.['master.key'], key, 'the sign-in service opens the same home')
        assert.notEqual(key, cluster.Secret(BootstrapFixture.Namespace, EngineSecretSet.TenantAdminMasterKey)?.data?.['master.key'], 'a key of its own')
        for (const [name, role] of [[EngineSecretSet.PostgresRealmSecretsConsole, 'realm_secrets_console'], [EngineSecretSet.PostgresRealmSecretsIdp, 'realm_secrets_idp'], [EngineSecretSet.PostgresRealmSecretsEnvironments, 'realm_secrets_environments']])
        {
            const secret = cluster.Secret(BootstrapFixture.Namespace, name)
            assert.equal(BootstrapFixture.Decoded(secret, 'database-url'), 'postgres://' + role + ':' + BootstrapFixture.Decoded(secret, 'password') + '@pragmatic-postgres.pragmatic-system.svc:5432/realm_secrets', name)
        }
        assert.equal(BootstrapFixture.Decoded(cluster.Secret(BootstrapFixture.IdpNamespace, EngineSecretSet.IdpRealmSecretsDatabase), 'database-url'),
            BootstrapFixture.Decoded(cluster.Secret(BootstrapFixture.Namespace, EngineSecretSet.PostgresRealmSecretsIdp), 'database-url'))
        assert.equal(cluster.Secret(BootstrapFixture.IdpNamespace, EngineSecretSet.PostgresRealmSecretsConsole), undefined, 'the role of the console never reaches the namespace of the sign-in service')
    })

    it('mints the console certificate for the console, the sign-in service and every environment of the base domain', async () =>
    {
        const minter = new RecordingMinter()
        await BootstrapFixture.Run(new MemoryCluster(), BootstrapFixture.Env(), minter)
        assert.deepEqual(minter.Minted, [
            ['pragmatic-idp-acme.pragmatic-idp-acme.svc.cluster.local', 'idp-acme.acme.example'],
            ['console.acme.example', 'idp-acme.acme.example', '*.acme.example'],
        ])
    })

    it('bootstrap over existing secrets changes nothing (byte-identical)', async () =>
    {
        const cluster = new MemoryCluster()
        await BootstrapFixture.Run(cluster)
        const before = cluster.Snapshot()
        const minter = new RecordingMinter()
        const report = await BootstrapFixture.Run(cluster, BootstrapFixture.Env(), minter)
        assert.equal(cluster.Snapshot(), before)
        assert.deepEqual(report.Created, [])
        assert.deepEqual(minter.Minted, [], 'nothing is minted for a kept Secret')
        const minted = EngineSecretSet.Specs(true).filter(s => s.Origin === EngineSecretOrigin.Minted && s.Name !== EngineSecretSet.DevCa)
        assert.equal(report.Kept.length, minted.length + 6, 'every minted Secret and the three components\' configuration objects')
    })

    it('a partially present set mints only the missing ones', async () =>
    {
        const cluster = new MemoryCluster()
        await BootstrapFixture.Run(cluster)
        const keptMaster = cluster.Secret(BootstrapFixture.Namespace, EngineSecretSet.TenantAdminMasterKey)
        cluster.Objects.delete('/api/v1/namespaces/pragmatic-system/secrets/' + EngineSecretSet.OwnerInitial)
        cluster.Objects.delete('/api/v1/namespaces/pragmatic-idp-acme/secrets/' + EngineSecretSet.IdpSigningKey)
        const report = await BootstrapFixture.Run(cluster)
        assert.deepEqual([...report.Created].sort(), ['pragmatic-idp-acme/' + EngineSecretSet.IdpSigningKey, 'pragmatic-system/' + EngineSecretSet.OwnerInitial].sort())
        assert.deepEqual(cluster.Secret(BootstrapFixture.Namespace, EngineSecretSet.TenantAdminMasterKey), keptMaster)
    })

    it('refuses another tenant or hive over a kept engine, writing nothing', async () =>
    {
        const cluster = new MemoryCluster()
        await BootstrapFixture.Run(cluster)
        const before = cluster.Snapshot()
        await assert.rejects(BootstrapFixture.Run(cluster, BootstrapFixture.Env({ PRAGMATIC_BOOTSTRAP_TENANT_ID: 'other', PRAGMATIC_BOOTSTRAP_IDP_NAMESPACE: 'pragmatic-idp-other' })),
            /already holds the engine of tenant acme, hive acme-hive.*names tenant other, hive acme-hive/)
        await assert.rejects(BootstrapFixture.Run(cluster, BootstrapFixture.Env({ PRAGMATIC_BOOTSTRAP_HIVE_ID: 'other-hive' })), /names tenant acme, hive other-hive/)
        assert.equal(cluster.Snapshot(), before)
    })

    it('mints the console certificate and its CA again as a pair when either is missing', async () =>
    {
        const cluster = new MemoryCluster()
        await BootstrapFixture.Run(cluster)
        cluster.Objects.delete('/api/v1/namespaces/pragmatic-system/secrets/' + EngineSecretSet.DevCa)
        const minter = new RecordingMinter()
        const report = await BootstrapFixture.Run(cluster, BootstrapFixture.Env(), minter)
        assert.equal(minter.Minted.length, 1)
        assert.ok(report.Created.includes('pragmatic-system/' + EngineSecretSet.ConsoleTls))
        assert.equal(BootstrapFixture.Decoded(cluster.Secret(BootstrapFixture.Namespace, EngineSecretSet.DevCa), 'ca.crt'), 'ca-1')
        assert.equal(BootstrapFixture.Decoded(cluster.Secret(BootstrapFixture.Namespace, EngineSecretSet.ConsoleTls), 'tls.crt'), 'cert-1')
        assert.equal(BootstrapFixture.Decoded(cluster.Secret(BootstrapFixture.Namespace, EngineSecretSet.DevCaKey), 'ca.key'), 'ca-key-1', 'the CA key is kept beside it (C3.4 renewal)')
        assert.equal(cluster.Secret(BootstrapFixture.IdpNamespace, EngineSecretSet.DevCaKey), undefined, 'the CA key is never copied out')
        assert.equal(BootstrapFixture.Decoded(cluster.Secret(BootstrapFixture.IdpNamespace, EngineSecretSet.ConsoleTls), 'tls.crt'), 'cert-1', 'the copy follows')
    })

    it('labels both engine namespaces Pod Security restricted, once: the helm-made one is patched, the IdP one created labelled', async () =>
    {
        const cluster = new MemoryCluster()
        const ns = '/api/v1/namespaces/'
        cluster.Objects.set(ns + BootstrapFixture.Namespace, { metadata: { name: BootstrapFixture.Namespace, labels: { 'kubernetes.io/metadata.name': BootstrapFixture.Namespace } } })
        const bootstrap = (): EngineBootstrap => new EngineBootstrap(new KubeApiClient(cluster), BootstrapSettings.From(BootstrapFixture.Env()), new RecordingMinter(), new CountingRandom(), () => new Date('2026-11-24T00:00:00Z'))
        const first = await bootstrap().RunNamespace()
        assert.deepEqual(first.Created, [BootstrapFixture.IdpNamespace])
        assert.deepEqual(first.Refreshed, [BootstrapFixture.Namespace], 'only the helm-made namespace needed a patch')
        for (const name of [BootstrapFixture.Namespace, BootstrapFixture.IdpNamespace])
        {
            assert.equal(cluster.Objects.get(ns + name)?.metadata.labels?.[EngineBootstrap.PodSecurityEnforceLabel], 'restricted', name)
        }
        assert.equal(cluster.Objects.get(ns + BootstrapFixture.Namespace)?.metadata.labels?.['kubernetes.io/metadata.name'], BootstrapFixture.Namespace, 'other labels stay')
        cluster.Writes.splice(0)
        const again = await bootstrap().RunNamespace()
        assert.deepEqual(again.Refreshed, [])
        assert.deepEqual(cluster.Writes, [], 'nothing is written when the labels are right')
        cluster.Objects.get(ns + BootstrapFixture.IdpNamespace)!.metadata.labels![EngineBootstrap.PodSecurityEnforceLabel] = 'privileged'
        assert.deepEqual((await bootstrap().RunNamespace()).Refreshed, [BootstrapFixture.IdpNamespace], 'a weaker label is put back')
    })

    it('a standalone engine gets no hive agent configuration objects', async () =>
    {
        const cluster = new MemoryCluster()
        await BootstrapFixture.Run(cluster, BootstrapFixture.Env({ PRAGMATIC_BOOTSTRAP_LEVEL: 'standalone' }))
        assert.equal(cluster.Objects.has('/api/v1/namespaces/pragmatic-system/configmaps/pragmatic-config-pragmatic-hive-agent'), false)
        assert.ok(cluster.Objects.has('/api/v1/namespaces/pragmatic-system/configmaps/pragmatic-config-pragmatic-tenant-admin'))
    })

    it('the namespace step creates only the sign-in service namespace, once', async () =>
    {
        const cluster = new MemoryCluster()
        const output = new RecordingOutput()
        assert.equal(await BootstrapCli.Run(BootstrapFixture.Env(), output, cluster, new RecordingMinter(), new CountingRandom(), 'namespace'), 0)
        assert.deepEqual([...cluster.Objects.keys()], ['/api/v1/namespaces/' + BootstrapFixture.IdpNamespace])
        assert.ok(output.Lines.includes('created ' + BootstrapFixture.IdpNamespace))
        const again = new RecordingOutput()
        assert.equal(await BootstrapCli.Run(BootstrapFixture.Env(), again, cluster, new RecordingMinter(), new CountingRandom(), 'namespace'), 0)
        assert.ok(again.Lines.includes('kept ' + BootstrapFixture.IdpNamespace))
    })

    it('never touches a configuration object the console wrote', async () =>
    {
        const cluster = new MemoryCluster()
        await BootstrapFixture.Run(cluster)
        const path = '/api/v1/namespaces/pragmatic-system/configmaps/pragmatic-config-pragmatic-tenant-admin'
        const written = { ...cluster.Objects.get(path)!, data: { 'configuration.json': '{"options":{}}' } }
        cluster.Objects.set(path, written)
        await BootstrapFixture.Run(cluster)
        assert.deepEqual(cluster.Objects.get(path), written)
    })

    it('copies the operator certificate for the sign-in service, and fails naming it when it is absent', async () =>
    {
        const env = BootstrapFixture.Env({ PRAGMATIC_BOOTSTRAP_TLS_MODE: 'secret', PRAGMATIC_BOOTSTRAP_TLS_SECRET: 'acme-tls' })
        const missing = new MemoryCluster()
        await assert.rejects(BootstrapFixture.Run(missing, env), /source is absent: pragmatic-system\/acme-tls/)
        const cluster = new MemoryCluster()
        cluster.Objects.set('/api/v1/namespaces/pragmatic-system/secrets/acme-tls', { metadata: { name: 'acme-tls' }, type: 'kubernetes.io/tls', data: { 'tls.crt': 'Y2VydA==', 'tls.key': 'a2V5' } })
        await BootstrapFixture.Run(cluster, env)
        assert.deepEqual(cluster.Secret(BootstrapFixture.IdpNamespace, 'acme-tls')?.data, { 'tls.crt': 'Y2VydA==', 'tls.key': 'a2V5' })
        assert.equal(cluster.Secret(BootstrapFixture.Namespace, EngineSecretSet.ConsoleTls), undefined)
    })

    it('the report and the log name secrets, never values', async () =>
    {
        const cluster = new MemoryCluster()
        const output = new RecordingOutput()
        assert.equal(await BootstrapCli.Run(BootstrapFixture.Env(), output, cluster, new RecordingMinter(), new CountingRandom()), 0)
        const values = [...cluster.Objects.values()].flatMap(o => Object.values(o.data ?? {}).flatMap(v => [v, Buffer.from(v, 'base64').toString('utf8')]))
        for (const line of output.Lines)
        {
            for (const value of values.filter(v => v.length >= 8))
            {
                assert.ok(!line.includes(value), 'a log line carries a secret value')
            }
        }
        assert.ok(output.Lines.some(line => line === 'created pragmatic-system/' + EngineSecretSet.PostgresSuperuser))
        assert.match(output.Lines.at(-1) ?? '', /^bootstrap done: \d+ created, 0 kept, \d+ refreshed$/)
    })

    it('refuses secret mode without a secret name and an unknown mode', () =>
    {
        assert.throws(() => BootstrapSettings.From(BootstrapFixture.Env({ PRAGMATIC_BOOTSTRAP_TLS_MODE: 'secret' })), /tls.secretName/)
        assert.throws(() => BootstrapSettings.From(BootstrapFixture.Env({ PRAGMATIC_BOOTSTRAP_TLS_MODE: 'acme' })), /unknown value/)
    })
})
