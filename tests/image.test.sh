#!/usr/bin/env bash
# The pragmatic-tenant-admin image on a docker host: the runtime files the console reads are in place, and the entry
# point loads its whole module graph and stops on missing configuration (never on a missing module).
# Run: bash tests/image.test.sh <image>   (e.g. ghcr.io/pragmatic-tech-ai/pragmatic-tenant-admin:ci)
# Every container it starts is removed (--rm); it creates nothing else.
set -euo pipefail

IMAGE="${1:?usage: image.test.sh <image>}"
APP_ROOT=/workspace/pragmatic-tenant-admin
MODULE_ERROR='ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package'
MISSING_ENV='Missing required environment variable: PRAGMATIC_TENANT_ADMIN_DATA_ROOT'
MISSING_KEY='Tenant-admin master key file not found: /tmp/tenant-admin-data/master.key'
FAILED=0

pass()
{
    echo "ok - $1"
}

fail()
{
    echo "not ok - $1" >&2
    FAILED=1
}

# The files the console reads at run time, relative to the app root (absolute paths as they are).
EXPECTED=(
    "$APP_ROOT/dist/bin/pragmatic-tenant-admind.js"
    "$APP_ROOT/dist/bin/pragmatic-tenant-admin-import.js"
    "$APP_ROOT/tenant-portal/dist/index.html"
    "$APP_ROOT/node_modules/@pragmatic-tech-ai/pragmatic-tenant-plane/templates"
    "$APP_ROOT/node_modules/@pragmatic-tech-ai/pragmatic-tenant-plane/environments/sample-apps"
    "$APP_ROOT/node_modules/@pragmatic-tech-ai/pragmatic-tenant-plane/environments/demo/seed"
    "/pragmatic/component.json"
)
for path in "${EXPECTED[@]}"; do
    if docker run --rm --entrypoint test "$IMAGE" -e "$path"; then
        pass "the image holds $path"
    else
        fail "the image lacks $path"
    fi
done

# Expects the entry point to exit non-zero with `expected` in its output and no module error; extra args are docker run flags.
expect_stop()
{
    local name="$1" expected="$2"
    shift 2
    local output status=0
    output="$(timeout 60 docker run --rm "$@" "$IMAGE" 2>&1)" || status=$?
    if [ "$status" -eq 0 ]; then
        fail "$name: the console exited 0"
    elif printf '%s' "$output" | grep -Eq "$MODULE_ERROR"; then
        fail "$name: a module is missing: $output"
    elif ! printf '%s' "$output" | grep -Fq "$expected"; then
        fail "$name: expected '$expected', got (exit $status): $output"
    else
        pass "$name"
    fi
}

expect_stop 'no configuration stops on the first required variable' "$MISSING_ENV"
expect_stop 'a configuration without a master key stops on the key' "$MISSING_KEY" \
    -e PRAGMATIC_TENANT_ADMIN_DATA_ROOT=/tmp/tenant-admin-data \
    -e PRAGMATIC_TENANT_ADMIN_PORT=7100 \
    -e PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN=tenant.test

exit "$FAILED"
