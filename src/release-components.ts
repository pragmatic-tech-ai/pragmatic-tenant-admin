import { ContainerComponentSource, ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { TenantAdminComponent } from './tenant-admin-component.js'

/** This repository's one component, for `pragmatic-component-descriptors --components dist/release-components.js`. */
export const Components = new ContainerComponentSource(ReleaseApp.TenantAdmin, () => TenantAdminComponent.Descriptor())
