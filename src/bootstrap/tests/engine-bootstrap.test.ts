import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KubeMethod, type IKubeTransport, type KubeContentType, type KubeResponse } from '@pragmatic-tech-ai/pragmatic-kube'
import { BootstrapCli, type IBootstrapOutput } from '../bootstrap-cli.js'
import { BootstrapSettings } from '../bootstrap-settings.js'
import { EngineBootstrap, type IRandomSource } from '../engine-bootstrap.js'
import { EngineSecretOrigin, EngineSecretScope, EngineSecretSet } from '../engine-secret-set.js'
import type { ITlsMinter, TlsMaterial } from '../tls-minter.js'
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
        return { Ca: Buffer.from('ca-' + n), Cert: Buffer.from('cert-' + n), Key: Buffer.from('key-' + n) }
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
            PRAGMATIC_BOOTSTRAP_POSTGRES_HOST: 'pragmatic-postgres.pragmatic-system.svc',
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
        assert.equal(Buffer.from(cluster.Secret(BootstrapFixture.Namespace, EngineSecretSet.TenantAdminMasterKey)?.data?.['master.key'] ?? '', 'base64').length, 32)
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
        const report = await BootstrapFixture.Run(cluster)
        assert.equal(cluster.Snapshot(), before)
        assert.deepEqual(report.Created, [])
        const minted = EngineSecretSet.Specs(true).filter(s => s.Origin === EngineSecretOrigin.Minted && s.Name !== EngineSecretSet.DevCa)
        assert.equal(report.Kept.length, minted.length)
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
