import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { KubeApiClient, KubeMethod, type IKubeTransport, type KubeContentType, type KubeResponse } from '@pragmatic-tech-ai/pragmatic-kube'
import { EngineSecretSet } from '../../bootstrap/engine-secret-set.js'
import type { ITlsMinter, LeafMaterial, TlsMaterial } from '../../bootstrap/tls-minter.js'
import { CertificateRenewalKind, ConsoleCertificateRenewal, type ICertificateCopies } from '../console-certificate-renewal.js'

class RenewalFixture
{
    public static readonly CaPem = readFileSync(new URL('./fixtures/fixture-ca.crt', import.meta.url), 'utf8')
    public static readonly CaEnd = new X509Certificate(RenewalFixture.CaPem).validToDate
    /** The fixture CA's own key, and a key of no CA (test-only material). */
    public static readonly CaKey = readFileSync(new URL('./fixtures/fixture-ca.key', import.meta.url), 'utf8')
    public static readonly OtherKey = readFileSync(new URL('./fixtures/fixture-other.key', import.meta.url), 'utf8')
    public static readonly Base = '/api/v1/namespaces/pragmatic-system/secrets/'
}

/** The pragmatic-system Secrets: reads answer what is stored, writes (server-side apply) replace it. */
class SecretsTransport implements IKubeTransport
{
    public readonly Writes: { Name: string, Data: Record<string, string> }[] = []
    public readonly Stored = new Map<string, Record<string, string>>()

    public async Send(method: KubeMethod, path: string, body: string | undefined, contentType: KubeContentType): Promise<KubeResponse>
    {
        void contentType
        const name = path.replace(RenewalFixture.Base, '').split('?')[0] as string
        if (method === KubeMethod.Get)
        {
            const data = this.Stored.get(name)
            return data === undefined ? { status: 404, body: '{}' } : { status: 200, body: JSON.stringify({ data }) }
        }
        const parsed = JSON.parse(body ?? '{}') as { data: Record<string, string> }
        this.Writes.push({ Name: name, Data: parsed.data })
        this.Stored.set(name, parsed.data)
        return { status: 200, body: '{}' }
    }

    public Store(name: string, key: string, value: string): void
    {
        this.Stored.set(name, { [key]: Buffer.from(value).toString('base64') })
    }

    public Decoded(name: string, key: string): string
    {
        return Buffer.from(this.Stored.get(name)?.[key] ?? '', 'base64').toString('utf8')
    }
}

class FakeMinter implements ITlsMinter
{
    public readonly Leaves: { Hosts: string[], Ca: string, Key: string }[] = []
    public CaMints = 0

    public Mint(hosts: readonly string[]): TlsMaterial
    {
        void hosts
        this.CaMints += 1
        return { Ca: Buffer.from('NEW-CA\n'), Cert: Buffer.from('NEW-CERT'), Key: Buffer.from('NEW-KEY'), CaKey: Buffer.from('NEW-CA-KEY') }
    }

    public MintLeaf(hosts: readonly string[], caCert: Buffer, caKey: Buffer): LeafMaterial
    {
        this.Leaves.push({ Hosts: [...hosts], Ca: caCert.toString('utf8'), Key: caKey.toString('utf8') })
        return { Cert: Buffer.from('LEAF-CERT'), Key: Buffer.from('LEAF-KEY') }
    }
}

class CountingCopies implements ICertificateCopies
{
    public Refreshed = 0

    public async RefreshCopies(): Promise<void>
    {
        this.Refreshed += 1
    }
}

describe('ConsoleCertificateRenewal', () =>
{
    const Renewal = (transport: SecretsTransport, minter: FakeMinter, copies: CountingCopies, now: Date = new Date(RenewalFixture.CaEnd.getTime() - 365 * 86_400_000)): ConsoleCertificateRenewal =>
        new ConsoleCertificateRenewal(new KubeApiClient(transport), minter, EngineSecretSet.ConsoleTls, 'acme', 'console.acme.example', 'acme.example', copies, () => now)

    it('renews the certificate under the existing CA: the CA and its key stay, so what trusts the CA keeps trusting it', async () =>
    {
        const transport = new SecretsTransport()
        transport.Store(EngineSecretSet.DevCa, EngineSecretSet.CaKey, RenewalFixture.CaPem)
        transport.Store(EngineSecretSet.DevCaKey, EngineSecretSet.CaKeyKey, RenewalFixture.CaKey)
        const minter = new FakeMinter()
        const copies = new CountingCopies()
        assert.equal(await Renewal(transport, minter, copies).RenewAs(), CertificateRenewalKind.Leaf)
        assert.equal(minter.CaMints, 0, 'no new CA')
        assert.deepEqual(minter.Leaves[0]?.Hosts, ['console.acme.example', 'idp-acme.acme.example', '*.acme.example'])
        assert.equal(minter.Leaves[0]?.Ca.trim(), RenewalFixture.CaPem.trim())
        assert.equal(minter.Leaves[0]?.Key, RenewalFixture.CaKey)
        assert.deepEqual(transport.Writes.map(write => write.Name), [EngineSecretSet.ConsoleTls], 'only the certificate is written')
        assert.equal(transport.Decoded(EngineSecretSet.ConsoleTls, EngineSecretSet.TlsCertKey), 'LEAF-CERT')
        assert.equal(copies.Refreshed, 1)
    })

    it('a CA within its renewal window, or one whose key was never kept, is replaced with the old CA kept in the bundle', async () =>
    {
        for (const [keyKept, now] of [[true, new Date(RenewalFixture.CaEnd.getTime() - 30 * 86_400_000)], [false, new Date(RenewalFixture.CaEnd.getTime() - 365 * 86_400_000)]] as const)
        {
            const transport = new SecretsTransport()
            transport.Store(EngineSecretSet.DevCa, EngineSecretSet.CaKey, RenewalFixture.CaPem)
            if (keyKept)
            {
                transport.Store(EngineSecretSet.DevCaKey, EngineSecretSet.CaKeyKey, RenewalFixture.CaKey)
            }
            const minter = new FakeMinter()
            assert.equal(await Renewal(transport, minter, new CountingCopies(), now).RenewAs(), CertificateRenewalKind.NewCa)
            assert.deepEqual(transport.Writes.map(write => write.Name), [EngineSecretSet.DevCaKey, EngineSecretSet.DevCa, EngineSecretSet.ConsoleTls], 'key, CA bundle, then certificate')
            const bundle = transport.Decoded(EngineSecretSet.DevCa, EngineSecretSet.CaKey)
            assert.ok(bundle.startsWith('NEW-CA'), 'the new CA issues')
            assert.ok(bundle.includes(RenewalFixture.CaPem.trim()), 'the old CA is still trusted')
            assert.equal(transport.Decoded(EngineSecretSet.DevCaKey, EngineSecretSet.CaKeyKey), 'NEW-CA-KEY')
        }
    })

    it('a kept key that is not the CA\'s (a rotation stopped between its writes) is never used: a new CA, the old one kept', async () =>
    {
        const transport = new SecretsTransport()
        transport.Store(EngineSecretSet.DevCa, EngineSecretSet.CaKey, RenewalFixture.CaPem)
        transport.Store(EngineSecretSet.DevCaKey, EngineSecretSet.CaKeyKey, RenewalFixture.OtherKey)
        const minter = new FakeMinter()
        assert.equal(await Renewal(transport, minter, new CountingCopies()).RenewAs(), CertificateRenewalKind.NewCa)
        assert.equal(minter.Leaves.length, 0, 'nothing signed with the stray key')
        assert.ok(transport.Decoded(EngineSecretSet.DevCa, EngineSecretSet.CaKey).includes(RenewalFixture.CaPem.trim()))
        assert.equal(ConsoleCertificateRenewal.KeyMatches(RenewalFixture.CaPem, Buffer.from(RenewalFixture.CaKey)), true)
        assert.equal(ConsoleCertificateRenewal.KeyMatches(RenewalFixture.CaPem, Buffer.from('not a key')), false)
    })

    it('an old CA past its end is dropped from the bundle', async () =>
    {
        const transport = new SecretsTransport()
        transport.Store(EngineSecretSet.DevCa, EngineSecretSet.CaKey, RenewalFixture.CaPem)
        await Renewal(transport, new FakeMinter(), new CountingCopies(), new Date(RenewalFixture.CaEnd.getTime() + 86_400_000)).RenewAs()
        assert.equal(transport.Decoded(EngineSecretSet.DevCa, EngineSecretSet.CaKey).trim(), 'NEW-CA')
    })

    it('an operator\'s certificate is theirs: nothing is minted or written', async () =>
    {
        const transport = new SecretsTransport()
        const minter = new FakeMinter()
        const renewal = new ConsoleCertificateRenewal(new KubeApiClient(transport), minter, 'acme-wildcard-tls', 'acme', 'console.acme.example', 'acme.example', undefined)
        assert.equal(renewal.OwnCertificate, false)
        assert.equal(await renewal.Renew(), false)
        assert.equal(minter.CaMints + minter.Leaves.length + transport.Writes.length, 0)
    })

    it('reads every certificate of a bundle, issuer first', () =>
    {
        const two = Buffer.from(RenewalFixture.CaPem + '\n' + RenewalFixture.CaPem)
        assert.equal(ConsoleCertificateRenewal.Certificates(two).length, 2)
        assert.deepEqual(ConsoleCertificateRenewal.Certificates(undefined), [])
    })
})
