import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A freshly minted CA and the server certificate it signed, with the CA's key: the console keeps the development CA's key
 * (Secret pragmatic-tls-dev-ca-key, never copied out of pragmatic-system) so a rotation renews the certificate under the
 * same CA; every other caller drops it.
 */
export type TlsMaterial = { readonly Ca: Buffer; readonly Cert: Buffer; readonly Key: Buffer; readonly CaKey: Buffer }

/** A server certificate an existing CA signed, and its key. */
export type LeafMaterial = { readonly Cert: Buffer; readonly Key: Buffer }

/** Mints a name-constrained CA and a server certificate for `hosts` (a `*.` wildcard allowed). */
export interface ITlsMinter
{
    Mint(hosts: readonly string[]): TlsMaterial
    /** A new server certificate for `hosts` under the given CA (its certificate and key, PEM). */
    MintLeaf(hosts: readonly string[], caCert: Buffer, caKey: Buffer): LeafMaterial
}

/**
 * The openssl CLI minter (the console image installs openssl): a CA that may sign only for the given names (a wildcard's
 * domain and everything below it) and no IP address, and an RSA server certificate whose SANs are the hosts; or a server
 * certificate under a CA it is given. Keys are written to a private temporary folder, used once and removed with it.
 */
export class OpenSslTlsMinter implements ITlsMinter
{
    private static readonly Openssl = 'openssl'
    private static readonly ReqCmd = 'req'
    private static readonly X509Cmd = 'x509'
    private static readonly FlagX509 = '-x509'
    private static readonly FlagNewkey = '-newkey'
    private static readonly FlagNodes = '-nodes'
    private static readonly FlagKeyout = '-keyout'
    private static readonly FlagOut = '-out'
    private static readonly FlagDays = '-days'
    private static readonly FlagSubj = '-subj'
    private static readonly FlagAddext = '-addext'
    private static readonly FlagReq = '-req'
    private static readonly FlagIn = '-in'
    private static readonly FlagCa = '-CA'
    private static readonly FlagCaKey = '-CAkey'
    private static readonly FlagCaCreateSerial = '-CAcreateserial'
    private static readonly FlagExtfile = '-extfile'
    private static readonly TempPrefix = 'pragmatic-engine-tls-'
    /**
     * Ten years: these certificates chain to a private CA the engine minted (the sign-in service's internal one, and the
     * development CA of tls.mode=self-signed), which no browser holds to the public 398-day limit. Renewal: delete the
     * Secret and run helm upgrade (runbooks/customer-cluster.md); production installs bring their own certificate.
     */
    private static readonly ValidDays = '3650'
    private static readonly KeySpec = 'rsa:2048'
    private static readonly CaSubject = '/CN=Pragmatic engine CA'
    private static readonly SubjectPrefix = '/CN='
    private static readonly CaKeyFile = 'ca.key'
    private static readonly CaCertFile = 'ca.crt'
    private static readonly ServerKeyFile = 'server.key'
    private static readonly ServerCsrFile = 'server.csr'
    private static readonly ServerCertFile = 'server.crt'
    private static readonly ExtFile = 'server.ext'
    private static readonly WildcardPrefix = '*.'
    private static readonly HostPattern = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/
    private static readonly MaxCommonName = 64
    private static readonly LabelSeparator = '.'
    private static readonly Comma = ','
    private static readonly Eol = '\n'
    private static readonly DnsPrefix = 'DNS:'
    private static readonly PermittedPrefix = 'permitted;DNS:'
    private static readonly ExcludedIps = ['excluded;IP:0.0.0.0/0.0.0.0', 'excluded;IP:0:0:0:0:0:0:0:0/0:0:0:0:0:0:0:0']
    private static readonly SanPrefix = 'subjectAltName='
    private static readonly ServerExtensions = 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n'
    private static readonly CaConstraints = 'basicConstraints=critical,CA:TRUE,pathlen:0'
    private static readonly CaKeyUsage = 'keyUsage=critical,keyCertSign,cRLSign'
    private static readonly NameConstraintsPrefix = 'nameConstraints=critical,'
    private static readonly BadHost = 'not a DNS name a certificate can carry: '
    private static readonly NoHosts = 'a certificate needs at least one host'
    private static readonly PrivateMode = 0o600
    private static readonly OpensslFailed = 'openssl failed while minting a certificate (is the openssl CLI installed?)'

    public constructor(private readonly openssl: string = OpenSslTlsMinter.Openssl)
    {
    }

    public Mint(hosts: readonly string[]): TlsMaterial
    {
        const T = OpenSslTlsMinter
        T.CheckHosts(hosts)
        const dir = mkdtempSync(join(tmpdir(), T.TempPrefix))
        try
        {
            const p = (file: string): string => join(dir, file)
            const permitted = [...new Set(hosts.map(h => h.startsWith(T.WildcardPrefix) ? h.slice(T.WildcardPrefix.length) : h))]
            const constraints = T.NameConstraintsPrefix + [...permitted.map(h => T.PermittedPrefix + h), ...T.ExcludedIps].join(T.Comma)
            this.Run([T.ReqCmd, T.FlagX509, T.FlagNewkey, T.KeySpec, T.FlagNodes, T.FlagKeyout, p(T.CaKeyFile), T.FlagOut, p(T.CaCertFile), T.FlagDays, T.ValidDays,
                T.FlagSubj, T.CaSubject, T.FlagAddext, T.CaConstraints, T.FlagAddext, T.CaKeyUsage, T.FlagAddext, constraints])
            this.SignLeaf(hosts, p)
            return { Ca: readFileSync(p(T.CaCertFile)), Cert: readFileSync(p(T.ServerCertFile)), Key: readFileSync(p(T.ServerKeyFile)), CaKey: readFileSync(p(T.CaKeyFile)) }
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }

    public MintLeaf(hosts: readonly string[], caCert: Buffer, caKey: Buffer): LeafMaterial
    {
        const T = OpenSslTlsMinter
        T.CheckHosts(hosts)
        const dir = mkdtempSync(join(tmpdir(), T.TempPrefix))
        try
        {
            const p = (file: string): string => join(dir, file)
            writeFileSync(p(T.CaCertFile), caCert)
            writeFileSync(p(T.CaKeyFile), caKey, { mode: T.PrivateMode })
            this.SignLeaf(hosts, p)
            return { Cert: readFileSync(p(T.ServerCertFile)), Key: readFileSync(p(T.ServerKeyFile)) }
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }

    private static CheckHosts(hosts: readonly string[]): void
    {
        const T = OpenSslTlsMinter
        if (hosts.length === 0)
        {
            throw new Error(T.NoHosts)
        }
        for (const host of hosts)
        {
            if (!T.HostPattern.test(host))
            {
                throw new Error(T.BadHost + host)
            }
        }
    }

    /** The server key, its request and the certificate the CA in the folder signs for `hosts`. */
    private SignLeaf(hosts: readonly string[], p: (file: string) => string): void
    {
        const T = OpenSslTlsMinter
        this.Run([T.ReqCmd, T.FlagNewkey, T.KeySpec, T.FlagNodes, T.FlagKeyout, p(T.ServerKeyFile), T.FlagOut, p(T.ServerCsrFile), T.FlagSubj, T.SubjectPrefix + T.CommonNameOf(hosts)])
        writeFileSync(p(T.ExtFile), T.SanPrefix + hosts.map(h => T.DnsPrefix + h).join(T.Comma) + T.Eol + T.ServerExtensions)
        this.Run([T.X509Cmd, T.FlagReq, T.FlagIn, p(T.ServerCsrFile), T.FlagCa, p(T.CaCertFile), T.FlagCaKey, p(T.CaKeyFile), T.FlagCaCreateSerial,
            T.FlagOut, p(T.ServerCertFile), T.FlagDays, T.ValidDays, T.FlagExtfile, p(T.ExtFile)])
    }

    /** The first host that fits the 64-character CN limit and is no wildcard, else the first host's first label. */
    private static CommonNameOf(hosts: readonly string[]): string
    {
        const T = OpenSslTlsMinter
        const fitting = hosts.find(h => h.length <= T.MaxCommonName && !h.startsWith(T.WildcardPrefix))
        return fitting ?? (hosts[0].split(T.LabelSeparator)[0]).slice(0, T.MaxCommonName)
    }

    /** Runs openssl; its output (which can name files, never key bytes) is dropped, so a failure is one fixed sentence. */
    private Run(args: readonly string[]): void
    {
        try
        {
            execFileSync(this.openssl, args, { stdio: 'pipe' })
        }
        catch
        {
            throw new Error(OpenSslTlsMinter.OpensslFailed)
        }
    }
}
