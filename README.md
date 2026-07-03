# Postgres MCP Server

A secure, diagnostic-first Model Context Protocol server for PostgreSQL. It exposes bounded SQL execution, catalog resources, execution-plan analysis, slow-query statistics, and health signals over stdio or Streamable HTTP.

## Security model

`restricted` is the default mode. Every user query runs inside a PostgreSQL `READ ONLY` transaction with server-controlled statement, lock, row, and response-size limits. SQL inspection provides early feedback, while PostgreSQL remains the enforcement boundary.

Streamable HTTP defaults to loopback. A non-loopback listener fails startup unless a bearer token and explicit allowed hosts are configured. Origin validation, request-body limits, session capacity, idle expiration, and DELETE cleanup are enabled.

Important boundaries:

- Use a dedicated PostgreSQL role with only the privileges the MCP client needs.
- `MCP_DB_MODE=unrestricted` permits writes and should be enabled only for a tightly controlled role and endpoint.
- `EXPLAIN ANALYZE` executes a query. It is disabled unless `MCP_ALLOW_EXPLAIN_ANALYZE=true`, accepts query statements only, and still runs in a read-only transaction.
- Static bearer authentication is suitable for local and private-network deployments. Internet-facing deployments should terminate TLS and enforce an OAuth-aware identity layer in front of the server.

## MCP surface

| Tool | Purpose |
| --- | --- |
| `server_info` | Server version, database identity, safeguards, limits, and pool status |
| `list_schemas` | Schemas, owners, and current-user privileges |
| `list_objects` | Tables, views, materialized views, sequences, functions, indexes, and extensions |
| `get_object_details` | Columns, constraints, indexes, statistics, and function definitions |
| `list_extensions` | Installed PostgreSQL extensions |
| `execute_sql` | One bounded, parameterized SQL statement |
| `explain_query` | PostgreSQL `EXPLAIN (FORMAT JSON)` with optional gated analysis |
| `diagnose_query` | Deterministic plan findings and advisory index candidates |
| `list_slow_queries` | `pg_stat_statements` execution and I/O rankings |
| `database_health` | Connections, cache, locks, temporary I/O, and maintenance signals |

Catalog context is also available through MCP resources:

- `postgres://catalog`
- `postgres://catalog/schema/{schema}/{objectType}`
- `postgres://catalog/object/{schema}/{objectType}/{objectName}`

Tool results include both `structuredContent` and a JSON text representation for client compatibility.

## Requirements

- Node.js 20 or newer
- PostgreSQL 14 or newer
- Podman for the provided local end-to-end test harness

## Install and build

```bash
npm ci
npm run check
npm run test:unit
npm run build
```

## Run over stdio

```bash
DATABASE_URI='postgres://mcp_reader:password@127.0.0.1:5432/app?sslmode=disable' \
MCP_TRANSPORT=stdio \
MCP_DB_MODE=restricted \
node build/index.js
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "node",
      "args": ["/absolute/path/postgres-mcp-server/build/index.js"],
      "env": {
        "DATABASE_URI": "postgres://mcp_reader:password@127.0.0.1:5432/app?sslmode=disable",
        "MCP_DB_MODE": "restricted"
      }
    }
  }
}
```

## Run over Streamable HTTP

Loopback development:

```bash
DATABASE_URI='postgres://mcp_reader:password@127.0.0.1:5432/app?sslmode=disable' \
MCP_TRANSPORT=http \
MCP_HTTP_HOST=127.0.0.1 \
MCP_AUTH_TOKEN='replace-with-a-long-random-token' \
node build/index.js
```

The MCP endpoint is `http://127.0.0.1:8899/mcp`. Health endpoints are `/healthz` and `/readyz`.

A non-loopback listener also requires explicit host policy:

```bash
MCP_TRANSPORT=http \
MCP_HTTP_HOST=0.0.0.0 \
MCP_AUTH_TOKEN='replace-with-a-long-random-token' \
MCP_ALLOWED_HOSTS='db-mcp.example.internal,127.0.0.1' \
MCP_ALLOWED_ORIGINS='https://mcp-client.example.internal' \
node build/index.js
```

## Podman

Build and run the server image:

```bash
npm ci
npm run build
podman build -t postgres-mcp-server:latest .
podman run --rm -p 127.0.0.1:8899:8899 \
  -e MCP_TRANSPORT=http \
  -e MCP_HTTP_HOST=0.0.0.0 \
  -e MCP_AUTH_TOKEN='replace-with-a-long-random-token' \
  -e MCP_ALLOWED_HOSTS='localhost,127.0.0.1' \
  -e DATABASE_URI='postgres://mcp_reader:password@host.containers.internal:5432/app?sslmode=disable' \
  postgres-mcp-server:latest
```

Run the full test suite against an ephemeral PostgreSQL 17 container:

```bash
podman machine start
npm run test:e2e:podman
```

The harness starts PostgreSQL with `pg_stat_statements`, builds the server, runs stdio and authenticated HTTP MCP tests, and removes the container afterward.
Set `POSTGRES_TEST_IMAGE` or `POSTGRES_TEST_PORT` to override its image or host port.

See the [Podman MCP-to-Postgres E2E runbook](docs/podman-e2e-runbook.md) for one-time VM setup, all eight test scenarios, expected evidence, cleanup behavior, and troubleshooting.

## Query diagnostics

`explain_query` returns the PostgreSQL JSON plan and a normalized summary. `diagnose_query` walks the plan tree and reports signals such as:

- large sequential scans
- row-estimate mismatches
- rows discarded by filters
- disk-backed sorts and temporary I/O
- high-volume nested loops
- advisory index columns inferred from scan filters

Index candidates are suggestions, not DDL. Validate them against representative data, write overhead, existing indexes, and preferably hypothetical plans through HypoPG.

`list_slow_queries` requires `pg_stat_statements` to be preloaded and installed:

```sql
CREATE EXTENSION pg_stat_statements;
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URI` / `POSTGRES_URL` / `DATABASE_URL` | PG environment | PostgreSQL connection URI |
| `MCP_DB_MODE` | `restricted` | `restricted` or `unrestricted` |
| `MCP_TRANSPORT` | `stdio` | `stdio`, `http`, or legacy alias `sse` |
| `MCP_HTTP_HOST` | `127.0.0.1` | HTTP bind address |
| `MCP_HTTP_PORT` | `8899` | HTTP port |
| `MCP_AUTH_TOKEN` | unset | Static bearer token |
| `MCP_ALLOWED_HOSTS` | loopback hosts | Comma-separated Host allowlist |
| `MCP_ALLOWED_ORIGINS` | loopback origins | Comma-separated Origin allowlist |
| `MCP_ENABLE_LEGACY_SSE` | `false` | Enable deprecated `/sse` and `/messages` transport |
| `MCP_STATEMENT_TIMEOUT_MS` | `15000` | PostgreSQL statement timeout |
| `MCP_LOCK_TIMEOUT_MS` | `3000` | PostgreSQL lock timeout |
| `MCP_QUERY_TIMEOUT_MS` | `20000` | Client and idle transaction timeout |
| `MCP_MAX_ROWS` | `1000` | Maximum requested rows |
| `MCP_MAX_RESULT_BYTES` | `2000000` | Maximum serialized result size |
| `MCP_MAX_BODY_BYTES` | `1000000` | Maximum HTTP request size |
| `MCP_REQUEST_TIMEOUT_MS` | `60000` | Maximum time to receive an HTTP request |
| `MCP_MAX_SESSIONS` | `100` | Maximum concurrent HTTP sessions |
| `MCP_SESSION_TTL_MS` | `1800000` | Idle HTTP session lifetime |
| `MCP_ALLOW_EXPLAIN_ANALYZE` | `false` | Permit query execution during diagnostics |
| `MCP_SSL_FALLBACK_TO_DISABLE` | `false` | Explicitly permit TLS downgrade after SSL rejection |

Standard `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, and TLS certificate variables are supported by `pg`. Percent-encode reserved characters in connection URI credentials.

## Development verification

```bash
npm run check
npm run test:unit
npm run test:e2e:podman
npm pack --dry-run
```

CI repeats type checks, unit tests, container-backed MCP tests, dependency audit, package inspection, and a rootless runtime image build.

## License

Apache-2.0. See [LICENSE](LICENSE).
