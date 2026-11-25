import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'
import { describe, it } from 'node:test'
import type { AddressInfo } from 'node:net'
import { connect, createServer } from 'node:tls'
import { OpenSslTlsMinter } from '../tls-minter.js'

class MinterFixture
{
    /** Whether this box has the openssl CLI (the console image does; a developer box may not). Windows runs skip: its MSYS openssl rewrites the /CN= subject argument as a path. */
    public static HasOpenssl(): boolean
    {
        try
        {
            execFileSync('openssl', ['version'], { stdio: 'pipe' })
            return true
        }
        catch
        {
            return false
        }
    }
}

describe('OpenSslTlsMinter', () =>
{
    it('mints a CA and a server certificate for the hosts and a wildcard domain', { skip: process.platform === 'win32' || !MinterFixture.HasOpenssl() }, () =>
    {
        const material = new OpenSslTlsMinter().Mint(['console.acme.example', 'idp-acme.acme.example', '*.acme.example'])
        const ca = new X509Certificate(material.Ca)
        const cert = new X509Certificate(material.Cert)
        assert.ok(cert.verify(ca.publicKey), 'the CA signed the certificate')
        assert.equal(ca.ca, true)
        for (const host of ['console.acme.example', 'idp-acme.acme.example'])
        {
            assert.equal(cert.checkHost(host), host, host)
        }
        assert.equal(cert.checkHost('env-1.acme.example'), '*.acme.example', 'every environment of the base domain')
        assert.equal(cert.checkHost('other.example'), undefined)
        assert.match(material.Key.toString('utf8'), /-----BEGIN PRIVATE KEY-----/)
    })

    it('renews the server certificate under the same CA: a client created before the rotation, trusting only the old CA, still connects', { skip: process.platform === 'win32' || !MinterFixture.HasOpenssl() }, async () =>
    {
        const hosts = ['console.acme.example', 'idp-acme.acme.example', '*.acme.example']
        const minter = new OpenSslTlsMinter()
        const first = minter.Mint(hosts)
        const leaf = minter.MintLeaf(hosts, first.Ca, first.CaKey)
        const ca = new X509Certificate(first.Ca)
        const renewed = new X509Certificate(leaf.Cert)
        assert.ok(renewed.verify(ca.publicKey), 'the existing CA signed the renewed certificate')
        assert.ok(renewed.validToDate.getTime() <= ca.validToDate.getTime(), 'the leaf ends no later than its CA')
        assert.notEqual(renewed.serialNumber, new X509Certificate(first.Cert).serialNumber)
        assert.equal(renewed.checkHost('journey.acme.example'), '*.acme.example')
        // The environment's view: it was given the CA at its creation and reaches the sign-in service by name.
        const server = createServer({ cert: leaf.Cert, key: leaf.Key }, socket => socket.end())
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        try
        {
            const port = (server.address() as AddressInfo).port
            const authorized = await new Promise<boolean>((resolve, reject) =>
            {
                const socket = connect({ host: '127.0.0.1', port, servername: 'idp-acme.acme.example', ca: first.Ca }, () =>
                {
                    resolve(socket.authorized)
                    socket.destroy()
                })
                socket.on('error', reject)
            })
            assert.equal(authorized, true)
        }
        finally
        {
            await new Promise<void>(resolve => server.close(() => resolve()))
        }
    })

    it('a certificate under a CA never runs past the CA\'s end', () =>
    {
        const ca = readFileSync(new URL('../../intents/tests/fixtures/fixture-ca.crt', import.meta.url))
        const end = new X509Certificate(ca).validToDate
        assert.equal(OpenSslTlsMinter.LeafDays(ca, new Date(end.getTime() - 30 * 86_400_000 - 1000)), '30')
        assert.equal(OpenSslTlsMinter.LeafDays(ca, new Date(end.getTime() - 4000 * 86_400_000)), '3650', 'ten years at most')
        assert.throws(() => OpenSslTlsMinter.LeafDays(ca, new Date(end.getTime() + 1000)), /the CA has ended/)
    })

    it('refuses a host a certificate cannot carry', () =>
    {
        assert.throws(() => new OpenSslTlsMinter().Mint(['bad host']), /not a DNS name/)
        assert.throws(() => new OpenSslTlsMinter().Mint([]), /at least one host/)
    })
})
