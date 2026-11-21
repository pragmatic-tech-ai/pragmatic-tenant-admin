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
| `src/configuration/console-components.ts` | `ConsoleComponents`: the descriptors the console validates configurations against, the others from the vendored set. |
| `src/descriptors/` | The vendored, digest-pinned component descriptors (`digests.json`), staged at `dist/descriptors` in the image. |
| `src/tenant-admin-component.ts` | `TenantAdminComponent`: the component descriptor (version = `package.json` version). |
| `src/release-components.ts` | `Components`: the descriptor source the image build reads (`pragmatic-component-descriptors --components dist/release-components.js`). |
| `tenant-portal/` | The tenant portal SPA (Mural, `pragmatic-app-shell`), built to `tenant-portal/dist`, the console's static root. |
| `closure.json` | What the image copies; `pragmatic-closure-check` keeps it, the Dockerfile and the code in step. |

Tests: `src/tests` (composition, import, the injected IdP, environment reach, the seeded directory, the tenant API
routes the console mounts, configuration, the descriptor golden and its readers), `tests/` (the release module's
descriptor equals the pragmatic-server golden digest, one installed copy of TODL, todl-runtime and Mural, and the entry's
closure carries none of the dev-box drivers), `tenant-portal/src/**/tests` (the portal's view models and services).
