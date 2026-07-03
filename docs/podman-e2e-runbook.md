# Podman MCP-to-Postgres End-to-End Runbook

## Purpose

This runbook verifies the Postgres MCP server through real MCP clients against an ephemeral PostgreSQL 17 database. The test exercises both stdio and Streamable HTTP transports, database safety boundaries, query diagnostics, telemetry, and connection cleanup.

The Podman VM runs PostgreSQL. The Node.js test runner starts the MCP server processes on the host and communicates with PostgreSQL through a loopback-only port.

```text
Node.js E2E runner
  |-- MCP stdio client ----> MCP stdio server --|
  |-- MCP HTTP client -----> MCP HTTP server  --|--> PostgreSQL 17 in Podman
  |-- PostgreSQL admin probe -------------------|
```

The harness is implemented in [`scripts/test-e2e-podman.sh`](../scripts/test-e2e-podman.sh), and the assertions are in [`test/e2e/postgres-mcp.test.ts`](../test/e2e/postgres-mcp.test.ts).

## Prerequisites

- Node.js 20 or newer
- npm dependencies installed with `npm ci`
- Podman 5 or newer
- At least 2 GiB of memory available to the Podman VM
- Host port `55432` available, or another port selected with `POSTGRES_TEST_PORT`

Run all commands from the repository root.

## One-time Podman VM setup

Podman on macOS and Windows runs Linux containers inside a managed virtual machine. Linux hosts normally do not need the `podman machine` commands.

List existing machines:

```bash
podman machine list
```

If no machine exists, initialize one. `--import-native-ca` is useful on hosts that use organization-managed certificate authorities:

```bash
podman machine init --import-native-ca
```

Start the VM and verify the Podman connection:

```bash
podman machine start
podman info
```

`podman machine start` is safe to omit when the machine is already running.

## Run the full suite

Install dependencies and run the harness:

```bash
npm ci
npm run test:e2e:podman
```

For a complete local verification run, include static checks and unit tests:

```bash
npm run check
npm run test:unit
npm run test:e2e:podman
```

The E2E command performs these steps:

1. Assigns a random container name in the form `postgres-mcp-e2e-$RANDOM`.
2. Starts `public.ecr.aws/docker/library/postgres:17-alpine` in rootless Podman.
3. Publishes PostgreSQL only on `127.0.0.1:55432` by default.
4. Starts PostgreSQL with `shared_preload_libraries=pg_stat_statements` and `compute_query_id=on`.
5. Waits up to 60 seconds for `pg_isready` to report a ready database.
6. Builds the MCP server executable at `build/index.js`.
7. Runs the E2E test file with `TEST_DATABASE_URL` pointing at the container.
8. Removes the PostgreSQL container on success, failure, interruption, or termination.

## Database fixture

The test suite creates an isolated `mcp_test` schema containing:

- `accounts`: 100 rows
- `events`: 20,000 rows with common and rare categories
- `safety_sequence`: used to verify that mutating functions are blocked
- foreign keys, an identity column, and analyzed table statistics
- the `pg_stat_statements` extension

The suite drops and recreates `mcp_test` before testing, then drops it during teardown. The Podman database itself is ephemeral and is removed by the shell harness.

## Eight scenarios

| # | Scenario | Required evidence |
| --- | --- | --- |
| 1 | MCP discovery and resources | Expected tools are advertised, `server_info` reports version `0.2.0`, and `postgres://catalog` includes `mcp_test`. |
| 2 | Parameterized bounded reads | A parameterized account query returns five deterministic rows and reports truncation. |
| 3 | Restricted-mode mutation defense | `EXPLAIN ANALYZE DELETE` and `nextval(...)` are rejected; row count and sequence state remain unchanged. |
| 4 | Pooled connection cleanup | A session advisory lock is released before the pooled connection is reused. |
| 5 | PostgreSQL statement timeout | `pg_sleep(2)` is cancelled by the 300 ms server-side timeout before the 1.5 second query deadline. |
| 6 | Explain and query diagnosis | JSON plan analysis succeeds and identifies a deterministic `large_sequential_scan` finding. |
| 7 | Statistics and health | `list_slow_queries` reads `pg_stat_statements`, and `database_health` returns `healthy` or `degraded`. |
| 8 | Streamable HTTP security | Missing bearer authentication returns `401`, an untrusted Origin returns `403`, and an authenticated allowed client completes MCP discovery. |

## Security configuration exercised

The stdio server uses the following test limits:

| Setting | Test value |
| --- | --- |
| `MCP_DB_MODE` | `restricted` |
| `MCP_ALLOW_EXPLAIN_ANALYZE` | `true` |
| `MCP_STATEMENT_TIMEOUT_MS` | `300` |
| `MCP_QUERY_TIMEOUT_MS` | `1500` |
| `MCP_MAX_ROWS` | `100` |
| `MCP_MAX_RESULT_BYTES` | `1000000` |
| `PGSSLMODE` | `disable` for the loopback-only ephemeral database |

The HTTP scenario additionally enables bearer authentication, explicit Host allowlisting, and explicit Origin allowlisting on a dynamically allocated loopback port.

## Expected result

A successful run ends with a Node test summary equivalent to:

```text
tests 8
pass 8
fail 0
cancelled 0
skipped 0
```

Individual durations and the allocated HTTP port vary between runs. The server startup line should identify PostgreSQL 17, `access=restricted`, and `transport=stdio`.

## Harness overrides

Use another host port when `55432` is occupied:

```bash
POSTGRES_TEST_PORT=55433 npm run test:e2e:podman
```

Use another PostgreSQL 17 image when required by a registry mirror or local policy:

```bash
POSTGRES_TEST_IMAGE=registry.example.test/postgres:17-alpine \
npm run test:e2e:podman
```

The replacement image must accept the standard PostgreSQL image environment variables and provide `pg_isready` and `pg_stat_statements`.

To run the test file against an already running database, bypass the Podman harness:

```bash
TEST_DATABASE_URL='postgres://user:password@127.0.0.1:5432/postgres' \
npm run test:e2e
```

Do not point this command at a database where an existing `mcp_test` schema must be preserved. The suite deliberately drops that schema.

## Troubleshooting

### Podman cannot connect

```bash
podman machine list
podman machine start
podman info
```

If the machine was created before organization certificates were installed, recreate or update it according to local Podman policy so the registry certificate chain is trusted.

### PostgreSQL image cannot be pulled

Pull the default image separately to expose the registry error:

```bash
podman pull public.ecr.aws/docker/library/postgres:17-alpine
```

Use `POSTGRES_TEST_IMAGE` to select an approved mirror after verifying that it contains PostgreSQL 17 and `pg_stat_statements`.

### Host port is already in use

```bash
POSTGRES_TEST_PORT=55433 npm run test:e2e:podman
```

### PostgreSQL does not become ready

The harness prints the container logs after the 60-second readiness deadline. Check VM memory, image compatibility, and whether the selected image accepts PostgreSQL `-c` server options.

### A stale test container remains

Normal exits are covered by a cleanup trap. After a host crash or forced process termination, locate and remove any stale test container:

```bash
podman ps -a --filter 'name=postgres-mcp-e2e-'
podman rm -f <container-name>
```

## Test record

Capture these fields when attaching E2E evidence to an issue or pull request:

```text
Date:
Git commit:
Operating system:
Node.js version:
Podman version:
PostgreSQL image:
Command:
Result: 8 passed / 0 failed
Notes:
```

Useful evidence commands:

```bash
git rev-parse HEAD
node --version
podman version
podman machine list
```

When testing is finished, the VM may be stopped to release its resources:

```bash
podman machine stop
```
