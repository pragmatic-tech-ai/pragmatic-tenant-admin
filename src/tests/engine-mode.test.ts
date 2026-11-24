import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RolloutStandaloneError, RolloutUnavailableCode, RolloutUnavailableError } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { EngineComposition } from '../engine-composition.js'
import { EngineEnv, EngineMode } from '../engine-mode.js'
import { EngineRolloutClient } from '../tenant-api/engine-rollout-client.js'
import { HttpRolloutClient } from '../tenant-api/http-rollout-client.js'
import { UnconfiguredRolloutClient } from '../tenant-api/unconfigured-rollout-client.js'
import { TenantAdminServer } from '../tenant-admin-server.js'

class ModeFixture
{
    /** A fully configured agent channel (what a connected, enrolled console has). */
    public static readonly Channel: NodeJS.ProcessEnv = {
        PRAGMATIC_TENANT_ADMIN_ROLLOUT_URL: 'https://agent.example.com',
        PRAGMATIC_TENANT_ADMIN_ROLLOUT_TOKEN: 'token',
        PRAGMATIC_TENANT_ADMIN_ROLLOUT_HIVE_ID: 'hive-1',
    }
}

describe('engine mode', () =>
{
    it('Standalone answers 404 for the enrolment routes and builds no agent channel', async () =>
    {
        const client = TenantAdminServer.RolloutClientFrom({ ...ModeFixture.Channel, [EngineEnv.Mode]: EngineMode.Standalone })
        assert.ok(client instanceof EngineRolloutClient, 'no HTTP agent-channel client even with a channel configured')
        await assert.rejects(client.StatusFor('hive-1'), (err: unknown) => err instanceof RolloutStandaloneError && err.Code === RolloutUnavailableCode.Standalone)
        await assert.rejects(client.ManifestsFor('acme'), RolloutStandaloneError)
        await assert.rejects(client.AdoptTarget('hive-1', '1.0.0'), RolloutStandaloneError)
        await assert.rejects(client.LedgerFor('hive-1', 10), RolloutStandaloneError)
    })

    it('a connected engine before enrolment answers 503 naming it; an enrolled one talks to the channel', async () =>
    {
        const unenrolled = TenantAdminServer.RolloutClientFrom({ [EngineEnv.Mode]: EngineMode.Connected })
        await assert.rejects(unenrolled.StatusFor('hive-1'), (err: unknown) =>
            err instanceof RolloutUnavailableError && !(err instanceof RolloutStandaloneError) && err.Code === RolloutUnavailableCode.NotEnrolled)
        assert.ok(TenantAdminServer.RolloutClientFrom({ ...ModeFixture.Channel, [EngineEnv.Mode]: EngineMode.Connected }) instanceof HttpRolloutClient)
        assert.ok(TenantAdminServer.RolloutClientFrom({}) instanceof UnconfiguredRolloutClient, 'a pushed console is unchanged')
    })

    it('reads the chart mode and refuses an unknown one', () =>
    {
        assert.equal(EngineEnv.ModeOf({}), undefined)
        assert.equal(EngineEnv.ModeOf({ [EngineEnv.Mode]: 'standalone' }), EngineMode.Standalone)
        assert.throws(() => EngineEnv.ModeOf({ [EngineEnv.Mode]: 'hosted' }), /unknown value: hosted/)
    })

    it('the engine composition takes both release images or neither', () =>
    {
        const both = EngineComposition.From({ [EngineEnv.EnvServerImage]: 'server@sha256:a', [EngineEnv.UiUnpackImage]: 'unpack@sha256:b' })
        assert.deepEqual(both.Environment, { ServerImage: 'server@sha256:a', UiUnpackImage: 'unpack@sha256:b' })
        assert.equal(EngineComposition.From({}).Environment, undefined)
        assert.throws(() => EngineComposition.From({ [EngineEnv.EnvServerImage]: 'server@sha256:a' }), /both/)
        assert.equal(EngineComposition.From({ [EngineEnv.Mode]: 'standalone' }).Standalone, true)
    })
})
