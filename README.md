# pragmatic-tenant-admin

The tenant admin console (`pragmatic-tenant-admind`, image `ghcr.io/pragmatic-tech-ai/pragmatic-tenant-admin`): the
console that ships into a client hive. It serves the tenant portal (`tenant-portal/`), the tenant API over its own
Postgres database, and orchestrates its own hive's environments through the Kubernetes API with the pod's service
account. Its sign-in goes to the tenant's realm sign-in service (pragmatic-tenant-idp), which the platform provisioned.

Split out of pragmatic-server (seed commit `chore: seed from pragmatic-server@2a2e8138`); image name, port, environment
variables, wire paths and component descriptor are unchanged. The compiled entry moved from
`dist-tenant-admin/admin/control-plane/bin/` to `dist/bin/` (the image's `ENTRYPOINT`); a Kubernetes manifest that
still sets the old path as the container command fails to start this image. Most of the console's tenant plane (tenant API and sign-in,
environments, configuration, records, the environment seed and its data) lives in the transitional shared package
`@pragmatic-tech-ai/pragmatic-tenant-plane`, which it shares with the platform admin console's co-hosted tenant plane;
C5.3 folds that package back into this repository.

## Configuration

The console reads `PRAGMATIC_TENANT_ADMIN_*` (port, bind, data root, database URL file, portal folder, external
scheme/port, ingress TLS, rollout link, ...), the platform's `PRAGMATIC_IDP_*` injection and the delivered seed; the
component descriptor (`src/tenant-admin-component.ts`, golden in `src/tests/fixtures`) lists every setting with its
source and description.

## Development

Packages come from GitHub Packages (`@pragmatic-tech-ai` scope; `.npmrc` and `tenant-portal/.npmrc` read the token from
`NODE_AUTH_TOKEN`).

    npm ci
    npm run build
    npm test
    npm run typecheck
    npx pragmatic-closure-check
    cd tenant-portal && npm ci && npm test && npm run typecheck && npm run build

The image is built from `Dockerfile` with `docker-bake.hcl` in two steps (the header of either file shows the commands).
CI and the image release (tag `v<version>`, equal to `package.json`'s version) run pragmatic-shared's reusable container
workflows. The build files are rendered by `pragmatic-container-template` (`@pragmatic-tech-ai/pragmatic-release-toolkit`):

    npx pragmatic-container-template render --app pragmatic-tenant-admin --entry src/bin/pragmatic-tenant-admind.ts --ui tenant-portal --asset src/descriptors=dist/descriptors --out .
