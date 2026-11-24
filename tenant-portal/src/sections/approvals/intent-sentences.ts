import type { KeptIntentDto } from '../../tenant-types.js'

// What a platform intent asks, in plain words (C3.4): one sentence per action
// kind, naming the engine's components as people know them. Only the closed
// members the hive protocol carries are read; nothing else is shown.
export class IntentSentences
{
    private static readonly KindField = 'Kind'
    private static readonly ComponentField = 'Component'
    private static readonly VersionField = 'Version'
    private static readonly EnvironmentField = 'Environment'
    private static readonly PurposeField = 'Purpose'
    private static readonly SubjectField = 'Subject'
    private static readonly ScopeField = 'Scope'
    private static readonly NameField = 'Name'
    private static readonly RuntimePurpose = 'runtime'
    private static readonly Empty = ''
    private static readonly ComponentNames: Readonly<Record<string, string>> = {
        'pragmatic-tenant-idp': 'sign-in service',
        'pragmatic-tenant-admin': 'tenant admin console',
        'pragmatic-hive-agent': 'hive agent',
        'pragmatic-postgres': 'hive database',
        'pragmatic-env-server': 'environment server',
    }
    private static readonly Upgrade = 'Upgrade {component} to {version}'
    private static readonly CreateDevelopment = 'Create environment `{environment}`'
    private static readonly CreateRuntime = 'Create runtime environment `{environment}`'
    private static readonly Update = 'Move environment `{environment}` to {version}'
    private static readonly Delete = 'Delete environment `{environment}`'
    private static readonly RotateSentences: Readonly<Record<string, string>> = {
        'hive-key': "Renew this hive's identity key",
        'ingress-certificate': "Renew the console's certificate",
        'trust-root': "Trust Pragmatic's new signing key",
    }
    private static readonly RepairEngine = 'Repair the engine'
    private static readonly RepairComponent = 'Repair the {component}'
    private static readonly RepairEnvironment = 'Repair environment `{environment}`'
    private static readonly Unknown = 'A change this console does not recognise'
    private static readonly ComponentToken = '{component}'
    private static readonly VersionToken = '{version}'
    private static readonly EnvironmentToken = '{environment}'
    private static readonly Kinds = {
        ComponentAtVersion: 'component-at-version',
        CreateEnvironment: 'create-environment',
        UpdateEnvironment: 'update-environment',
        DeleteEnvironment: 'delete-environment',
        Rotate: 'rotate',
        Repair: 'repair',
    } as const
    private static readonly Scopes = { Engine: 'engine', Component: 'component', Environment: 'environment' } as const

    private constructor()
    {
    }

    public static Of(intent: KeptIntentDto): string
    {
        const S = IntentSentences
        const action = intent.Action
        switch (action[S.KindField])
        {
            case S.Kinds.ComponentAtVersion:
                return S.Upgrade.replace(S.ComponentToken, S.ComponentName(action[S.ComponentField])).replace(S.VersionToken, S.Text(action[S.VersionField]))
            case S.Kinds.CreateEnvironment:
                return (action[S.PurposeField] === S.RuntimePurpose ? S.CreateRuntime : S.CreateDevelopment).replace(S.EnvironmentToken, S.Text(action[S.EnvironmentField]))
            case S.Kinds.UpdateEnvironment:
                return S.Update.replace(S.EnvironmentToken, S.Text(action[S.EnvironmentField])).replace(S.VersionToken, S.Text(action[S.VersionField]))
            case S.Kinds.DeleteEnvironment:
                return S.Delete.replace(S.EnvironmentToken, S.Text(action[S.EnvironmentField]))
            case S.Kinds.Rotate:
                return S.RotateSentences[S.Text(action[S.SubjectField])] ?? S.Unknown
            case S.Kinds.Repair:
                return S.RepairOf(S.Text(action[S.ScopeField]), S.Text(action[S.NameField]))
            default:
                return S.Unknown
        }
    }

    // A component as people know it ("sign-in service"), else its name.
    public static ComponentName(value: unknown): string
    {
        const name = IntentSentences.Text(value)
        return IntentSentences.ComponentNames[name] ?? name
    }

    private static RepairOf(scope: string, name: string): string
    {
        const S = IntentSentences
        switch (scope)
        {
            case S.Scopes.Engine:
                return S.RepairEngine
            case S.Scopes.Component:
                return S.RepairComponent.replace(S.ComponentToken, S.ComponentName(name))
            case S.Scopes.Environment:
                return S.RepairEnvironment.replace(S.EnvironmentToken, name)
            default:
                return S.Unknown
        }
    }

    private static Text(value: unknown): string
    {
        return typeof value === 'string' ? value : String(value ?? IntentSentences.Empty)
    }
}
