import { ComponentDescriptorBuilder, SettingType, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import { ApplyTarget } from '@pragmatic-tech-ai/pragmatic-configuration'
import { ComponentDescriptorSet } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { ConfigurationTarget, type IConfigurationTargetSource } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { TenantAdminComponent } from '../../tenant-admin-component.js'
import type { IReleaseDescriptorReader } from '../release-descriptor-catalogue.js'

/** A release registry over fixed sets; `Down` makes every read fail; `Reads` counts them. */
export class FakeReleaseReader implements IReleaseDescriptorReader
{
    public Down = false
    public Reads = 0

    public constructor(private readonly releases: ReadonlyMap<string, ComponentDescriptorSet>)
    {
    }

    public async Descriptors(version: string): Promise<ComponentDescriptorSet>
    {
        this.Reads += 1
        const set = this.releases.get(version)
        if (this.Down || set === undefined) throw new Error('registry unreachable')
        return set
    }
}

/** Targets fixed by the test. */
export class FixedTargets implements IConfigurationTargetSource
{
    public constructor(public Targets: Map<string, ConfigurationTarget[]> = new Map())
    {
    }

    public async For(component: string): Promise<readonly ConfigurationTarget[]>
    {
        return this.Targets.get(component) ?? []
    }
}

/** Descriptors of a hive agent and an env server in two versions, as a release would carry them. */
export class ConfigurationFixture
{
    public static readonly Tenant = 'acme'
    public static readonly Admin = 'subject-admin'
    public static readonly Agent = 'pragmatic-hive-agent'
    public static readonly Server = 'pragmatic-env-server'

    public static Agent010(): ComponentDescriptor
    {
        return new ComponentDescriptorBuilder(ConfigurationFixture.Agent, '0.1.0')
            .Option('core', 'The agent', o => o
                .Setting('pollIntervalMs', SettingType.Integer, s => s.Default(30000))
                .Setting('token', SettingType.String, s => s.Secret()))
            .Build()
    }

    public static Agent020(): ComponentDescriptor
    {
        return new ComponentDescriptorBuilder(ConfigurationFixture.Agent, '0.2.0')
            .Option('core', 'The agent', o => o
                .Setting('pollIntervalMs', SettingType.Integer, s => s.Default(30000))
                .Setting('token', SettingType.String, s => s.Secret())
                .Setting('maxBackoffMs', SettingType.Integer, s => s.Default(300000)))
            .Build()
    }

    public static Server010(): ComponentDescriptor
    {
        return new ComponentDescriptorBuilder(ConfigurationFixture.Server, '0.1.0')
            .Option('core', 'The server', o => o.Setting('port', SettingType.Integer, s => s.Default(8080)))
            .Build()
    }

    /** The mounted set of the release the console runs. */
    public static Mounted(): ComponentDescriptorSet
    {
        return ComponentDescriptorSet.FromDescriptors([ConfigurationFixture.Agent010(), ConfigurationFixture.Server010(), TenantAdminComponent.Descriptor()])
    }

    /** A registry holding release 0.2.0 (agent 0.2.0) and release 0.1.0 (the mounted one). */
    public static Registry(): FakeReleaseReader
    {
        return new FakeReleaseReader(new Map([
            ['0.2.0', ComponentDescriptorSet.FromDescriptors([ConfigurationFixture.Agent020(), ConfigurationFixture.Server010()])],
            ['0.1.0', ConfigurationFixture.Mounted()],
        ]))
    }

    public static Target(name: string, namespace: string, deployment: string, descriptor?: ComponentDescriptor): ConfigurationTarget
    {
        return new ConfigurationTarget(name, new ApplyTarget('h1', namespace, deployment), descriptor?.ContentDigest(), descriptor?.Version)
    }
}
