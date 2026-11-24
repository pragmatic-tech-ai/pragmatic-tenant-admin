import { X509Certificate } from 'node:crypto'
import { KubeResourceCatalog, type KubeApiClient, type KubeTypeRef } from '@pragmatic-tech-ai/pragmatic-kube'
import { K8sManifestBuilder } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { EngineSecretSet } from '../bootstrap/engine-secret-set.js'
import type { ITlsMinter } from '../bootstrap/tls-minter.js'
import type { IConsoleCertificateRenewal } from './environment-intent-applier.js'

/** Copies the renewed certificate to the namespaces serving it (EngineComposition: IngressTlsCopies). */
export interface ICertificateCopies
{
    RefreshCopies(): Promise<void>
}

/** How a renewal went: the certificate under the same CA, or a new CA beside the old one. */
export enum CertificateRenewalKind
{
    /** Not the engine's own certificate (tls.mode=secret): the operator renews it. */
    NotOwn = 'not-own',
    /** A new certificate under the existing development CA: everything that trusts the CA keeps trusting it. */
    Leaf = 'leaf',
    /** The CA itself was due (or its key was never kept): a new CA, its bundle still carrying the old one. */
    NewCa = 'new-ca',
}

/**
 * Renews the console's ingress certificate for a rotate intent (C3.4), for an engine installed with
 * `tls.mode=self-signed`: a new server certificate for the console, the sign-in service and every environment of the
 * base domain, signed by the EXISTING development CA (its key kept in pragmatic-tls-dev-ca-key), so environments and
 * anything else that pinned the CA keep reaching sign-in. A new CA is minted only when the CA is within its renewal
 * window or its key was never kept (an engine bootstrapped before C3.4); then the CA bundle keeps the old CA beside the
 * new one until it expires. Then the copies are refreshed. A certificate the operator provides (`tls.mode=secret`) is
 * theirs to renew.
 */
export class ConsoleCertificateRenewal implements IConsoleCertificateRenewal
{
    public static readonly FieldManager = 'pragmatic-tenant-admin-tls-renewal'
    /** A CA closer than this to its end is replaced at the next rotation. */
    public static readonly CaRenewalWindowMs = 90 * 86_400_000
    private static readonly SecretType: KubeTypeRef = { apiVersion: 'v1', kind: 'Secret' }
    private static readonly SecretKind = 'Secret'
    private static readonly WildcardPrefix = '*.'
    private static readonly Base64 = 'base64'
    private static readonly Utf8 = 'utf8'
    private static readonly Engine = 'pragmatic-engine'
    private static readonly ManagedByLabel = 'app.kubernetes.io/managed-by'
    private static readonly PemBlock = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\s*/g
    private static readonly Eol = '\n'

    public constructor(
        private readonly client: KubeApiClient,
        private readonly minter: ITlsMinter,
        private readonly secretName: string | undefined,
        private readonly tenantId: string,
        private readonly consoleHost: string,
        private readonly baseDomain: string,
        private readonly copies: ICertificateCopies | undefined,
        private readonly now: () => Date = () => new Date())
    {
    }

    /** Whether the console serves the engine's own self-signed certificate (the only one it may renew). */
    public get OwnCertificate(): boolean
    {
        return this.secretName === EngineSecretSet.ConsoleTls
    }

    public async Renew(): Promise<boolean>
    {
        return await this.RenewAs() !== CertificateRenewalKind.NotOwn
    }

    public async RenewAs(): Promise<CertificateRenewalKind>
    {
        const C = ConsoleCertificateRenewal
        const S = EngineSecretSet
        if (!this.OwnCertificate)
        {
            return CertificateRenewalKind.NotOwn
        }
        const hosts = [this.consoleHost, K8sManifestBuilder.IdpBrowserHostOf(this.tenantId, this.baseDomain), C.WildcardPrefix + this.baseDomain]
        const bundle = C.Certificates(await this.Read(S.DevCa, S.CaKey))
        const caKey = await this.Read(S.DevCaKey, S.CaKeyKey)
        const current = bundle[0]
        if (current !== undefined && caKey !== undefined && !this.Due(current))
        {
            const leaf = this.minter.MintLeaf(hosts, Buffer.from(current, C.Utf8), caKey)
            await this.Write(S.ConsoleTls, S.TlsType, { [S.TlsCertKey]: leaf.Cert, [S.TlsKeyKey]: leaf.Key })
            await this.copies?.RefreshCopies()
            return CertificateRenewalKind.Leaf
        }
        const material = this.minter.Mint(hosts)
        // The old CAs that have not expired stay in the bundle, after the new one, so nothing that trusts them breaks now.
        const kept = bundle.filter(pem => new X509Certificate(pem).validToDate.getTime() > this.now().getTime())
        await this.Write(S.DevCaKey, S.OpaqueType, { [S.CaKeyKey]: material.CaKey })
        await this.Write(S.DevCa, S.OpaqueType, { [S.CaKey]: Buffer.concat([material.Ca, ...kept.map(pem => Buffer.from(C.Eol + pem.trim() + C.Eol, C.Utf8))]) })
        await this.Write(S.ConsoleTls, S.TlsType, { [S.TlsCertKey]: material.Cert, [S.TlsKeyKey]: material.Key })
        await this.copies?.RefreshCopies()
        return CertificateRenewalKind.NewCa
    }

    /** The PEM certificates of a bundle, first (the issuing CA) first. */
    public static Certificates(bundle: Buffer | undefined): string[]
    {
        return bundle === undefined ? [] : [...bundle.toString(ConsoleCertificateRenewal.Utf8).matchAll(ConsoleCertificateRenewal.PemBlock)].map(match => match[0])
    }

    private Due(caPem: string): boolean
    {
        return new X509Certificate(caPem).validToDate.getTime() - this.now().getTime() < ConsoleCertificateRenewal.CaRenewalWindowMs
    }

    private async Read(name: string, key: string): Promise<Buffer | undefined>
    {
        const C = ConsoleCertificateRenewal
        const secret = await this.client.Get(KubeResourceCatalog.PathOf(C.SecretType, K8sManifestBuilder.SystemNamespace, name)) as { data?: Record<string, string> } | undefined
        const value = secret?.data?.[key]
        return value === undefined ? undefined : Buffer.from(value, C.Base64)
    }

    private async Write(name: string, type: string, data: Readonly<Record<string, Buffer>>): Promise<void>
    {
        const C = ConsoleCertificateRenewal
        const encoded: Record<string, string> = {}
        for (const [key, value] of Object.entries(data))
        {
            encoded[key] = value.toString(C.Base64)
        }
        const namespace = K8sManifestBuilder.SystemNamespace
        await this.client.Apply(KubeResourceCatalog.PathOf(C.SecretType, namespace, name), {
            apiVersion: C.SecretType.apiVersion,
            kind: C.SecretKind,
            metadata: { name, namespace, labels: { [C.ManagedByLabel]: C.Engine } },
            type,
            data: encoded,
        }, C.FieldManager)
    }
}
