import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApplyTarget } from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import { ComponentSecretWriter } from '../component-secret-writer.js'
import { FakeCluster } from './fake-cluster.js'

describe('ComponentSecretWriter', () =>
{
    const Path = (ns: string): string => `/api/v1/namespaces/${ns}/secrets/pragmatic-secrets-pragmatic-env-server`

    it('writes the key into the component Secret of every target namespace and answers the reference', async () =>
    {
        const cluster = new FakeCluster()
        cluster.Put(Path('pragmatic-env-dev2'), { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'pragmatic-secrets-pragmatic-env-server' }, data: { other: 'eA==' } })
        const targets = [new ApplyTarget('h1', 'pragmatic-env-dev1', 'a'), new ApplyTarget('h1', 'pragmatic-env-dev2', 'b'), new ApplyTarget('h1', 'pragmatic-env-dev1', 'c')]
        const reference = await new ComponentSecretWriter(new KubeApiClient(cluster)).Put('pragmatic-env-server', 'smtp-password', 's3cret', targets)
        assert.equal(reference.Format(), 'secret:file/smtp-password')
        const created = cluster.Objects.get(Path('pragmatic-env-dev1'))!
        assert.equal(Buffer.from(created.data['smtp-password'], 'base64').toString(), 's3cret')
        assert.equal(created.metadata.labels['app.kubernetes.io/managed-by'], 'pragmatic-tenant-admin')
        const merged = cluster.Objects.get(Path('pragmatic-env-dev2'))!
        assert.deepEqual(Object.keys(merged.data).sort(), ['other', 'smtp-password'], 'other keys stay')
    })

    it('a refused write throws the status only, never the value', async () =>
    {
        const cluster = new FakeCluster()
        cluster.Refusals.set(`PATCH ${Path('pragmatic-env-dev1')}`, 403)
        await assert.rejects(new ComponentSecretWriter(new KubeApiClient(cluster)).Put('pragmatic-env-server', 'k', 'never-printed-value', [new ApplyTarget('h1', 'pragmatic-env-dev1', 'a')]),
            (error: Error) => !error.message.includes('never-printed-value'))
    })
})
