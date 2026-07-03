#!/usr/bin/env bash
set -euo pipefail

container_name="postgres-mcp-e2e-$RANDOM"
host_port="${POSTGRES_TEST_PORT:-55432}"
postgres_image="${POSTGRES_TEST_IMAGE:-public.ecr.aws/docker/library/postgres:17-alpine}"
database_url="postgres://postgres:postgres@127.0.0.1:${host_port}/postgres"

cleanup() {
  podman rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

podman run --detach --rm \
  --name "$container_name" \
  --publish "127.0.0.1:${host_port}:5432" \
  --env POSTGRES_PASSWORD=postgres \
  --env POSTGRES_DB=postgres \
  "$postgres_image" \
  -c shared_preload_libraries=pg_stat_statements \
  -c compute_query_id=on >/dev/null

for attempt in $(seq 1 60); do
  if podman exec "$container_name" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" == "60" ]]; then
    podman logs "$container_name"
    echo "PostgreSQL did not become ready." >&2
    exit 1
  fi
  sleep 1
done

npm run build
TEST_DATABASE_URL="$database_url" npm run test:e2e
