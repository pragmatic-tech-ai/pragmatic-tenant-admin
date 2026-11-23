# pragmatic-tenant-admin architecture

The console's composition and its in-hive seams live here; the tenant plane it composes (`TenantPlaneComposer`,
`TenantConsoleHost`, the tenant API endpoint, sessions, environments, configuration, records, the seed) comes from
`@pragmatic-tech-ai/pragmatic-tenant-plane`.

| File | Role |
|---|---|
| `src/bin/pragmatic-tenant-admind.ts` | The entry: `TenantAdminServer.Main()`. |
| `src/bin/pragmatic-tenant-admin-import.ts` | `TenantAdminImportBin`: imports a pre-A5 data root into the console database (`--force` to repeat). |
| `src/tenant-admin-server.ts` | `TenantAdminServer`: reads the environment, opens the database, composes the tenant plane (delivery, stores, services, host, health monitor, advert sender) and serves it with the tenant portal. |
| `src/tenant-admin-database.ts` | `TenantAdminDatabase`, `TenantAdminRegistry`: the console's own Postgres, one `records_<name>` table per registry. |
| `src/tenant-admin-import.ts` | `TenantAdminImport`: the pre-A5 data root files into the database (once; the files stay as the backup). |
| `src/console-delivery.ts` | `ConsoleDelivery`: the platform-delivered seed (tenant and hive) and verified images. |
| `src/console-owner-reset-follower.ts` | `ConsoleOwnerResetFollower`: ends an owner's sessions when the platform resets the owner. |
| `src/injected-idp-service.ts` | `InjectedIdpService`: connects to the IdP the operator provisioned (`PRAGMATIC_IDP_*`, Secret files); never launches one. |
| `src/unconfigured-idp-service.ts` | `UnconfiguredIdpService`: no IdP was injected (outside a provisioned pod). |
| `src/in-cluster-environment-reach.ts` | `InClusterEnvironmentReach`: reaches an environment by cluster DNS and its Owner secret through the API kubectl. |
| `src/tenant-api/seeded-tenant-directory.ts` | `SeededTenantDirectory`: a read-only directory of exactly the seeded tenant and its hives. |
| `src/tenant-api/http-rollout-client.ts` | `HttpRolloutClient`: adoptable versions, rollout status and adoption over the hive's agent channel. |
| `src/tenant-api/unconfigured-rollout-client.ts` | `UnconfiguredRolloutClient`: no rollout link yet; fails closed (503). |
| `src/configuration/console-configuration.ts` | `ConsoleConfiguration`: composes the configuration service (catalogue, label targets, watched applier, secret writer). |
| `src/configuration/release-descriptor-catalogue.ts` | `ReleaseDescriptorCatalogue`: descriptors from the mounted release set, then the signed adopted releases. |
| `src/configuration/label-configuration-targets.ts` | `LabelConfigurationTargets`: a component's Deployments by label, with the descriptor digest their image carries. |
| `src/configuration/kube-configuration-applier.ts`, `rollout-watch.ts` | The watched apply: ConfigMap and hash, wait for the roll, revert when it never readies. |
| `src/configuration/console-self-apply.ts`, `console-start-fallback.ts` | The console configuring itself: what ran before kept, put back by a start it refuses, the apply settled. |
| `src/configuration/component-secret-writer.ts` | `ComponentSecretWriter`: secret values into `pragmatic-secrets-<component>` of one target. |
| `src/tenant-admin-component.ts` | `TenantAdminComponent`: the component descriptor (version = `package.json` version). |
| `src/release-components.ts` | `Components`: the descriptor source the image build reads (`pragmatic-component-descriptors --components dist/release-components.js`). |
| `tenant-portal/` | The tenant portal SPA (Mural, `pragmatic-app-shell`), built to `tenant-portal/dist`, the console's static root. |
| `closure.json` | What the image copies; `pragmatic-closure-check` keeps it, the Dockerfile and the code in step. |

Tests:

- `src/tests` (`npm test`): composition, import, the injected IdP, environment reach, the seeded directory, the tenant
  API routes the console mounts, configuration, the descriptor golden and its readers. Its support files are copies made
  at the split (`component-golden.ts`, `component-sources.ts` from pragmatic-server's component tests;
  `res-recorder.ts`, `tenant-test-sessions.ts`, also copied into pragmatic-tenant-plane's tests).
- `tests/*.test.ts` (`npm test`): the release module's descriptor equals the pinned digest, one installed copy of TODL, todl-runtime and Mural, and the entry's closure carries none of the dev-box
  drivers.
- `tests/image.test.sh <image>` (CI, after the bake): the runtime files are in the image and the entry stops on missing
  configuration, never on a missing module.
- `tenant-portal/src/**/tests` (`npm test` in `tenant-portal`): the portal's view models and services;
  `tenant-portal/tests` holds the Playwright spec (`npm run test:e2e`, against `fake-tenant-control-plane.ts`).
