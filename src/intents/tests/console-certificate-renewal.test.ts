import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KubeApiClient, type IKubeTransport, type KubeContentType, type KubeMethod, type KubeResponse } from '@pragmatic-tech-ai/pragmatic-kube'
import { EngineSecretSet } from '../../bootstrap/engine-secret-set.js'
import type { ITlsMinter, TlsMaterial } from '../../bootstrap/tls-minter.js'
import { ConsoleCertificateRenewal, type ICertificateCopies } from '../console-certificate-renewal.js'

class RecordingTransport implements IKubeTransport
{
    public readonly Writes: { Path: string, Body: { metadata: { name: string }, data: Record<string, string> } }[] = []

    public async Send(method: KubeMethod, path: string, body: string | undefined, contentType: KubeContentType): Promise<KubeResponse>
    {
        void method
        void contentType
        this.Writes.push({ Path: path, Body: JSON.parse(body ?? '{}') })
        return { status: 200, body: '{}' }
    }
}

class FixedMinter implements ITlsMinter
{
    public readonly Hosts: string[][] = []

    public Mint(hosts: readonly string[]): TlsMaterial
    {
        this.Hosts.push([...hosts])
        return { Ca: Buffer.from('CA'), Cert: Buffer.from('CERT'), Key: Buffer.from('KEY') }
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
    it('re-mints the engine\'s own certificate for the console, sign-in service and environments, CA first, then refreshes the copies', async () =>
    {
        const transport = new RecordingTransport()
        const minter = new FixedMinter()
        const copies = new CountingCopies()
        const renewal = new ConsoleCertificateRenewal(new KubeApiClient(transport), minter, EngineSecretSet.ConsoleTls, 'acme', 'console.acme.example', 'acme.example', copies)
        assert.equal(await renewal.Renew(), true)
        assert.deepEqual(minter.Hosts[0], ['console.acme.example', 'idp-acme.acme.example', '*.acme.example'])
        assert.deepEqual(transport.Writes.map(write => write.Body.metadata.name), [EngineSecretSet.DevCa, EngineSecretSet.ConsoleTls])
        assert.ok(transport.Writes.every(write => write.Path.includes('/namespaces/pragmatic-system/secrets/')))
        assert.equal(transport.Writes[1]?.Body.data[EngineSecretSet.TlsCertKey], Buffer.from('CERT').toString('base64'))
        assert.equal(copies.Refreshed, 1)
    })

    it('an operator\'s certificate is theirs: nothing is minted or written', async () =>
    {
        const transport = new RecordingTransport()
        const minter = new FixedMinter()
        const renewal = new ConsoleCertificateRenewal(new KubeApiClient(transport), minter, 'acme-wildcard-tls', 'acme', 'console.acme.example', 'acme.example', undefined)
        assert.equal(renewal.OwnCertificate, false)
        assert.equal(await renewal.Renew(), false)
        assert.equal(minter.Hosts.length + transport.Writes.length, 0)
    })
})
