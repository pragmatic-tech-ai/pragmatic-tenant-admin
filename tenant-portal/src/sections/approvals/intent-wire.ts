// The hive protocol's closed values the Approvals page reads off the console's tenant API (pragmatic-hive-protocol
// IntentProgress, IntentDecisionRefusal, IntentFailure). The portal does not depend on the protocol package; the
// console's tests hold these equal to it (tests/intent-wire-parity.test.ts). No imports: the console's
// tests load this file directly.

// Where an intent stands, as the hive agent reports it (the hive protocol's IntentProgress).
export enum IntentProgressDto
{
    AwaitingApproval = 'awaiting-approval',
    Applying = 'applying',
    Applied = 'applied',
    Rejected = 'rejected',
    Failed = 'failed',
    Expired = 'expired',
}

// Why the hive agent did not take a decision (the hive protocol's IntentDecisionRefusal).
export enum DecisionRefusal
{
    Malformed = 'malformed',
    NotEnrolled = 'not-enrolled',
    UnknownIntent = 'unknown-intent',
    NotAwaiting = 'not-awaiting',
    Expired = 'expired',
    DigestMismatch = 'digest-mismatch',
    Unavailable = 'unavailable',
}

// Why an intent failed, as the hive reports it (the hive protocol's IntentFailure).
export enum IntentFailureDto
{
    PrecheckRefused = 'precheck-refused',
    EnvironmentNotFound = 'environment-not-found',
    EnvironmentExists = 'environment-exists',
    VersionUnavailable = 'version-unavailable',
    NotReady = 'not-ready',
    ConsoleUnavailable = 'console-unavailable',
    RotationRefused = 'rotation-refused',
    RecheckFailed = 'recheck-failed',
    ApplyFailed = 'apply-failed',
}
