import { ConsoleEnvironmentListing, EnvironmentReadiness, EnvironmentStatus, HiveReport, ProtocolNames } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { EnvStatus, type EnvironmentRecord, type IEnvironmentService } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import type { EnvironmentIntentApplier } from './environment-intent-applier.js'

/**
 * What the console tells its hive agent about its environments (C3.4 review: an Enrolled or Delegated agent lists no
 * Deployments; the console, which owns them, answers `GET /internal/environments`): each of its hive's environments,
 * reconciled with the cluster, by name, with readiness (running: ready; an intent creating it: progressing; one
 * deleting it: deleting; anything else: not ready) and the version it runs (the engine's: every environment runs the
 * engine's environment server), when that is a semantic version. Names that are no DNS label are left out.
 */
export class ConsoleEnvironments
{
    public constructor(
        private readonly service: Pick<IEnvironmentService, 'ListReconciled'>,
        private readonly applier: Pick<EnvironmentIntentApplier, 'IsCreating' | 'IsDeleting'>,
        private readonly hiveId: () => string,
        private readonly engineVersion: string | undefined)
    {
    }

    public async List(): Promise<ConsoleEnvironmentListing>
    {
        const hive = this.hiveId()
        const version = this.engineVersion !== undefined && ProtocolNames.Version.test(this.engineVersion) ? this.engineVersion : null
        const seen = new Set<string>()
        const statuses: EnvironmentStatus[] = []
        for (const record of await this.service.ListReconciled())
        {
            if ((record.hiveId !== undefined && record.hiveId !== hive) || !ProtocolNames.Label.test(record.name) || seen.has(record.name) || statuses.length >= HiveReport.MaxEnvironments)
            {
                continue
            }
            seen.add(record.name)
            statuses.push(new EnvironmentStatus(record.name, this.ReadinessOf(record), version))
        }
        return ConsoleEnvironmentListing.Of(statuses)
    }

    /** The record's status as the protocol's readiness. */
    public ReadinessOf(record: EnvironmentRecord): EnvironmentReadiness
    {
        if (this.applier.IsDeleting(record.name))
        {
            return EnvironmentReadiness.Deleting
        }
        if (this.applier.IsCreating(record.name))
        {
            return EnvironmentReadiness.Progressing
        }
        return record.status === EnvStatus.Running ? EnvironmentReadiness.Ready : EnvironmentReadiness.NotReady
    }
}
