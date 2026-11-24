#!/usr/bin/env bash
# The live HivePostgresProvisioner tests and the openssl minter test, on a Linux box with Docker (hive-laptop WSL:
# bin\hive.cmd run --wsl <clone> -- bash tests/live/hive-postgres.sh). Starts a throwaway pragmatic-postgres (the release
# image) on a fixed loopback port (a restart keeps it), runs the tests against its superuser, removes it. The superuser
# password is random and never printed.
set -euo pipefail
image="${PRAGMATIC_TEST_POSTGRES_IMAGE:-ghcr.io/pragmatic-tech-ai/pragmatic-postgres@sha256:9a1583a99b16c912280112c049f37449729d94a50a90ad02790d96bd86b6d59d}"
name="pragmatic-hive-pg-test-$$"
port="$((20000 + $$ % 10000))"
work="$(mktemp -d)"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
mkdir -p "$work/secrets/applications" "$work/config"
head -c 24 /dev/urandom | base64 | tr -d '+/=\n' > "$work/secrets/superuser"
: > "$work/config/applications.conf"
chmod -R a+rX "$work"
docker run -d --name "$name" -p "127.0.0.1:${port}:5432" \
    -v "$work/secrets:/run/secrets/pragmatic-postgres:ro" -v "$work/config:/etc/pragmatic-postgres:ro" \
    "$image" >/dev/null
for _ in $(seq 1 60); do docker exec "$name" pg_isready --host=127.0.0.1 --quiet && break; sleep 1; done
export PRAGMATIC_TEST_HIVE_PG_SUPERUSER_URL="postgres://postgres:$(cat "$work/secrets/superuser")@127.0.0.1:${port}/postgres"
export PRAGMATIC_TEST_HIVE_PG_CONTAINER="$name"
npx tsx --test src/environments/tests/hive-postgres-provisioner.test.ts src/bootstrap/tests/tls-minter.test.ts
