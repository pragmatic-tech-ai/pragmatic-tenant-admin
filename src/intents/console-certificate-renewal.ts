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

/**
 * Renews the console's ingress certificate for a rotate intent (C3.4): an engine installed with `tls.mode=self-signed`
 * mints a new development CA and certificate (the console, the sign-in service and every environment of the base
 * domain, as the bootstrap does), writes the CA first and then the certificate, and refreshes the copies. A certificate
 * the operator provides (`tls.mode=secret`) is theirs to renew: false.
 */
export class ConsoleCertificateRenewal implements IConsoleCertificateRenewal
{
    public static readonly FieldManager = 'pragmatic-tenant-admin-tls-renewal'
    private static readonly SecretType: KubeTypeRef = { apiVersion: 'v1', kind: 'Secret' }
    private static readonly SecretKind = 'Secret'
    private static readonly WildcardPrefix = '*.'
    private static readonly Base64 = 'base64'
    private static readonly Engine = 'pragmatic-engine'
    private static readonly ManagedByLabel = 'app.kubernetes.io/managed-by'

    public constructor(
        private readonly client: KubeApiClient,
        private readonly minter: ITlsMinter,
        private readonly secretName: string | undefined,
        private readonly tenantId: string,
        private readonly consoleHost: string,
        private readonly baseDomain: string,
        private readonly copies: ICertificateCopies | undefined)
    {
    }

    /** Whether the console serves the engine's own self-signed certificate (the only one it may renew). */
    public get OwnCertificate(): boolean
    {
        return this.secretName === EngineSecretSet.ConsoleTls
    }

    public async Renew(): Promise<boolean>
    {
        const C = ConsoleCertificateRenewal
        const S = EngineSecretSet
        if (!this.OwnCertificate)
        {
            return false
        }
        const material = this.minter.Mint([this.consoleHost, K8sManifestBuilder.IdpBrowserHostOf(this.tenantId, this.baseDomain), C.WildcardPrefix + this.baseDomain])
        await this.Write(S.DevCa, S.OpaqueType, { [S.CaKey]: material.Ca })
        await this.Write(S.ConsoleTls, S.TlsType, { [S.TlsCertKey]: material.Cert, [S.TlsKeyKey]: material.Key })
        await this.copies?.RefreshCopies()
        return true
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
