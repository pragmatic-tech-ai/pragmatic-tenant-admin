import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { IntentDecisionRefusal, IntentFailure, IntentProgress } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { DecisionRefusal, IntentFailureDto, IntentProgressDto } from '../tenant-portal/src/sections/approvals/intent-wire.js'

/** The portal copies the protocol's closed values (it does not depend on the protocol package): they must not drift. */
class WireParity
{
    public static Values(enumeration: object): string[]
    {
        return Object.values(enumeration).map(String).sort()
    }
}

describe('the Approvals page\'s copy of the hive protocol\'s values', () =>
{
    it('every intent progress, failure and decision refusal the console can answer, and nothing else', () =>
    {
        assert.deepEqual(WireParity.Values(IntentProgressDto), WireParity.Values(IntentProgress))
        assert.deepEqual(WireParity.Values(IntentFailureDto), WireParity.Values(IntentFailure))
        // The console answers the agent's refusal of itself as unavailable, so the page never sees not-console.
        assert.deepEqual(WireParity.Values(DecisionRefusal), WireParity.Values(IntentDecisionRefusal).filter(code => code !== IntentDecisionRefusal.NotConsole))
    })
})
