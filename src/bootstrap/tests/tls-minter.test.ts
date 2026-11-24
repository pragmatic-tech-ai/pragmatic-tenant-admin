import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { describe, it } from 'node:test'
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

    it('refuses a host a certificate cannot carry', () =>
    {
        assert.throws(() => new OpenSslTlsMinter().Mint(['bad host']), /not a DNS name/)
        assert.throws(() => new OpenSslTlsMinter().Mint([]), /at least one host/)
    })
})
