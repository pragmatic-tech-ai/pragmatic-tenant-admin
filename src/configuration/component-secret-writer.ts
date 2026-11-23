import { SecretReference } from '@pragmatic-tech-ai/pragmatic-component'
import type { ApplyTarget } from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeApiError, KubeContentType, KubeResourceCatalog, type KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import { ComponentConfigurationMounts, type IComponentSecretWriter } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

/**
 * Writes a component's secret values into its own Secret `pragmatic-secrets-<component>` (key `<name>`), in the namespace
 * of every target, where the component's secret store `file` reads them (mounted read-only at
 * `/run/secrets/pragmatic/<component>`): until the realm's secrets come home (2.5), a component's secrets live in the
 * customer's own cluster. The key is merged into the Secret (other keys stay); a Secret not there yet is created. The
 * answer is the reference a configuration uses, `secret:file/<name>`; the value is never logged, kept or answered, and a
 * refused write throws the cluster's status only.
 */
export class ComponentSecretWriter implements IComponentSecretWriter
{
    public static readonly Store = 'file'
    private static readonly SecretType = { apiVersion: 'v1', kind: 'Secret' }
    private static readonly OpaqueType = 'Opaque'
    private static readonly Base64 = 'base64'
    private static readonly NotFound = 404
    private static readonly ApiVersionKey = 'apiVersion'
    private static readonly KindKey = 'kind'
    private static readonly MetadataKey = 'metadata'
    private static readonly NameKey = 'name'
    private static readonly NamespaceKey = 'namespace'
    private static readonly LabelsKey = 'labels'
    private static readonly TypeKey = 'type'
    private static readonly DataKey = 'data'

    public constructor(private readonly client: KubeApiClient)
    {
    }

    public async Put(component: string, name: string, value: string, targets: readonly ApplyTarget[]): Promise<SecretReference>
    {
        const encoded = Buffer.from(value).toString(ComponentSecretWriter.Base64)
        for (const namespace of new Set(targets.map(t => t.Namespace)))
        {
            await this.Merge(component, namespace, name, encoded)
        }
        return new SecretReference(ComponentSecretWriter.Store, name)
    }

    private async Merge(component: string, namespace: string, name: string, encoded: string): Promise<void>
    {
        const W = ComponentSecretWriter
        const secretName = ComponentConfigurationMounts.SecretNameOf(component)
        const path = KubeResourceCatalog.PathOf(W.SecretType, namespace, secretName)
        const data = { [name]: encoded }
        if (await this.TryPatch(path, data)) return
        const created = await this.client.Create(KubeResourceCatalog.PathOf(W.SecretType, namespace), {
            [W.ApiVersionKey]: W.SecretType.apiVersion,
            [W.KindKey]: W.SecretType.kind,
            [W.MetadataKey]: {
                [W.NameKey]: secretName,
                [W.NamespaceKey]: namespace,
                [W.LabelsKey]: { [ComponentConfigurationMounts.ManagedByLabel]: ComponentConfigurationMounts.ManagedBy, [ComponentConfigurationMounts.ComponentLabel]: component },
            },
            [W.TypeKey]: W.OpaqueType,
            [W.DataKey]: data,
        })
        // Created meanwhile by another write: merge into it.
        if (!created) await this.client.Patch(path, { [W.DataKey]: data }, KubeContentType.MergePatch)
    }

    private async TryPatch(path: string, data: Record<string, string>): Promise<boolean>
    {
        try
        {
            await this.client.Patch(path, { [ComponentSecretWriter.DataKey]: data }, KubeContentType.MergePatch)
            return true
        }
        catch (error)
        {
            if (error instanceof KubeApiError && error.Status === ComponentSecretWriter.NotFound) return false
            throw error
        }
    }
}
