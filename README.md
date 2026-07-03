# Postgres MCP Server

[![CI](https://img.shields.io/github/actions/workflow/status/shadabshaukat/postgres-mcp-server/ci.yml?branch=main&style=flat-square&label=CI&logo=githubactions&logoColor=white)](https://github.com/shadabshaukat/postgres-mcp-server/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-2ea44f?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14%2B-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio%20%7C%20HTTP-6D4AFF?style=flat-square)](https://modelcontextprotocol.io/)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com/)
[![Podman](https://img.shields.io/badge/Podman-tested-892CA0?style=flat-square&logo=podman&logoColor=white)](https://podman.io/)

A secure PostgreSQL Model Context Protocol server with bounded SQL execution, deterministic query tuning, workload analysis, scored database monitoring, and Prometheus metrics.

## Quick start: Docker or Podman

Container deployment is the recommended way to run this server. The release includes the compiled `build/index.js`, so container users do not need Node.js or npm.

### 1. Requirements

| Requirement | Version or guidance |
| --- | --- |
| Container runtime | Docker or Podman |
| PostgreSQL | 14 or newer |
| Database account | Dedicated role with only the privileges the MCP client needs |

Clone the repository and enter it:

```bash
git clone https://github.com/shadabshaukat/postgres-mcp-server.git
cd postgres-mcp-server
```

### 2. Build the image

Docker:

```bash
docker build --tag postgres-mcp-server:latest .
```

Podman:

```bash
# macOS and Windows only; omit when the machine is already running.
podman machine start
podman build --format docker --tag postgres-mcp-server:latest .
```

### 3. Connect Codex

The simplest local configuration lets Codex launch a short-lived stdio container automatically. The same MCP configuration is shared by the Codex app, CLI, and IDE extension.

Docker:

```bash
codex mcp add postgres \
  --env DATABASE_URI='postgres://mcp_reader:password@db-host:5432/app?sslmode=require' \
  -- docker run --rm -i \
  --env DATABASE_URI \
  --env MCP_TRANSPORT=stdio \
  --env MCP_DB_MODE=restricted \
  postgres-mcp-server:latest
```

For Podman, use the same command with `podman run` after the `--` separator.

Verify the configuration:

```bash
codex mcp list
```

Start a new Codex session. In the CLI, `/mcp` shows the connected tools. In the Codex app, open **Settings > Integrations & MCP** to review the shared configuration.

You can also configure Codex directly in `~/.codex/config.toml`:

```toml
[mcp_servers.postgres]
command = "docker" # Change to "podman" when using Podman.
args = [
  "run", "--rm", "-i",
  "--env", "DATABASE_URI",
  "--env", "MCP_TRANSPORT=stdio",
  "--env", "MCP_DB_MODE=restricted",
  "postgres-mcp-server:latest"
]
startup_timeout_sec = 30
tool_timeout_sec = 120

[mcp_servers.postgres.env]
DATABASE_URI = "postgres://mcp_reader:password@db-host:5432/app?sslmode=require"
```

### 4. Connect Claude Desktop

For a local database or local container, use Claude Desktop's local MCP configuration. Do not use Claude's remote custom connector for `localhost`; remote connectors originate from Anthropic's cloud and require a publicly reachable server.

Open **Claude Desktop > Settings > Developer > Edit Config**. The configuration file is normally:

| Platform | File |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Add this configuration:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "--env",
        "DATABASE_URI",
        "--env",
        "MCP_TRANSPORT=stdio",
        "--env",
        "MCP_DB_MODE=restricted",
        "postgres-mcp-server:latest"
      ],
      "env": {
        "DATABASE_URI": "postgres://mcp_reader:password@db-host:5432/app?sslmode=require"
      }
    }
  }
}
```

For Podman, change `"command": "docker"` to `"command": "podman"`.

Completely quit and restart Claude Desktop. Open **+ > Connectors** in a conversation to confirm that `postgres` and its tools are available. If Claude cannot find Docker or Podman, replace `command` with the absolute path returned by `command -v docker` or `command -v podman`.

These quick-start examples store `DATABASE_URI` in a local client configuration file. Protect that file with user-only permissions and use a dedicated least-privilege database role. For managed deployments, inject the URI through your normal secret-management process instead.

### Database host from a container

The database hostname is resolved from inside the MCP container:

| Database location | Hostname in `DATABASE_URI` |
| --- | --- |
| Remote PostgreSQL | Its normal DNS name or IP address |
| PostgreSQL on Docker Desktop host | `host.docker.internal` |
| PostgreSQL on Podman host | `host.containers.internal` |
| PostgreSQL in the same Compose network | Its Compose service name |

Percent-encode reserved characters in URI usernames and passwords. Use `sslmode=require` or `sslmode=verify-full` for remote databases; use `sslmode=disable` only for a trusted local database that does not support TLS.

## Optional: long-running HTTP service

Use Streamable HTTP when several clients share one server or when the MCP process should run independently of a desktop client.

Docker:

```bash
docker run --detach --name postgres-mcp \
  --publish 127.0.0.1:8899:8899 \
  --env DATABASE_URI='postgres://mcp_reader:password@db-host:5432/app?sslmode=require' \
  --env MCP_TRANSPORT=http \
  --env MCP_HTTP_HOST=0.0.0.0 \
  --env MCP_AUTH_TOKEN='replace-with-a-long-random-token' \
  --env MCP_ALLOWED_HOSTS='localhost,127.0.0.1' \
  --env MCP_ALLOWED_ORIGINS='http://localhost:8899,http://127.0.0.1:8899' \
  --env MCP_ENABLE_METRICS=true \
  postgres-mcp-server:latest
```

For Podman, replace `docker` with `podman`.

Check readiness:

```bash
curl http://127.0.0.1:8899/readyz
```

The endpoints are:

| Endpoint | Purpose |
| --- | --- |
| `http://127.0.0.1:8899/mcp` | Streamable HTTP MCP |
| `http://127.0.0.1:8899/healthz` | Process liveness |
| `http://127.0.0.1:8899/readyz` | PostgreSQL readiness |
| `http://127.0.0.1:8899/metrics` | Prometheus metrics when enabled |

Connect Codex to the running HTTP service:

```bash
export POSTGRES_MCP_TOKEN='replace-with-a-long-random-token'
codex mcp add postgres-http \
  --url http://127.0.0.1:8899/mcp \
  --bearer-token-env-var POSTGRES_MCP_TOKEN
```

Make `POSTGRES_MCP_TOKEN` available whenever Codex starts. For a public deployment, terminate TLS at a trusted reverse proxy and use an OAuth-aware identity layer rather than exposing the static-token endpoint directly.

### Docker Compose

```bash
export DATABASE_URI='postgres://mcp_reader:password@db-host:5432/app?sslmode=require'
export MCP_AUTH_TOKEN='replace-with-a-long-random-token'
docker compose --file docker-compose.example.yml up --detach --build
```

Use `podman compose` instead when a Podman Compose provider is installed.

## Manual npm deployment

Use this only when Docker or Podman is not suitable.

Requirements: Node.js 20 or newer and npm.

```bash
npm ci
npm run check
npm run test:unit
npm run build
```

Run over stdio:

```bash
DATABASE_URI='postgres://mcp_reader:password@127.0.0.1:5432/app?sslmode=disable' \
MCP_TRANSPORT=stdio \
MCP_DB_MODE=restricted \
node build/index.js
```

Register the manual build with Codex:

```bash
codex mcp add postgres-npm \
  --env DATABASE_URI='postgres://mcp_reader:password@127.0.0.1:5432/app?sslmode=disable' \
  -- node /absolute/path/to/postgres-mcp-server/build/index.js
```

For Claude Desktop, use the earlier JSON example with `command` set to the absolute path of `node`, `args` set to the absolute `build/index.js` path, and `DATABASE_URI` in `env`.

Run a loopback HTTP server manually:

```bash
DATABASE_URI='postgres://mcp_reader:password@127.0.0.1:5432/app?sslmode=disable' \
MCP_TRANSPORT=http \
MCP_HTTP_HOST=127.0.0.1 \
MCP_AUTH_TOKEN='replace-with-a-long-random-token' \
node build/index.js
```

## Security model

`restricted` is the default mode. Every user query runs inside a PostgreSQL `READ ONLY` transaction with server-controlled statement, lock, row, and response-size limits. SQL inspection provides early feedback, while PostgreSQL remains the enforcement boundary.

| Boundary | Guidance |
| --- | --- |
| PostgreSQL role | Use a dedicated least-privilege role |
| `MCP_DB_MODE=unrestricted` | Permits writes; use only for a tightly controlled role and endpoint |
| `EXPLAIN ANALYZE` | Executes the query; disabled unless `MCP_ALLOW_EXPLAIN_ANALYZE=true` |
| HTTP exposure | Non-loopback binding requires a bearer token and explicit allowed hosts |
| Public access | Terminate TLS and add an OAuth-aware identity layer |

## Feature matrix

| Area | Features | Availability or requirement |
| --- | --- | --- |
| SQL safety | Read-only transactions, single-statement inspection, parameter binding, timeouts, cancellation, row limits, and result-size limits | Enabled by default in `restricted` mode |
| Query execution | Bounded `SELECT`, `WITH`, and `VALUES` results with truncation metadata | Built in |
| Plan capture | JSON `EXPLAIN` with costs, settings, summaries, and optional `ANALYZE`, buffers, WAL, and timing | `ANALYZE` requires explicit opt-in |
| Plan diagnostics | Sequential scans, estimate errors, filtering waste, disk sorts, temporary I/O, nested-loop volume, risk score, and plan-node summaries | Built in |
| Plan comparison | Structural fingerprints, cost and timing deltas, node-type changes, risk deltas, and verdicts | Built in |
| Index advisor | Existing-index coverage, workload context, selectivity, advisory concurrent-index SQL, and confidence | Built in; never applies DDL |
| Hypothetical indexes | Baseline versus hypothetical planner-cost comparison | Automatic when HypoPG is installed |
| Workload statistics | Calls, planning and execution variance, rows, cache activity, temporary I/O, I/O timing, WAL, role, and reset metadata | Requires `pg_stat_statements` |
| Health scoring | Configurable connection, duration, cache, dead-tuple, XID-age, replication-lag, lock, and pool thresholds | Built in |
| Activity and locks | Long queries, idle transactions, lock waits, and blocker graph | Visibility follows PostgreSQL role privileges |
| Maintenance | Tuple health, scan mix, analyze/vacuum history, XID age, and table size | Built in |
| Replication and durability | Replica or receiver state, replay lag, WAL, checkpoints, restartpoints, and archiver status | Version and server-role aware |
| PostgreSQL I/O | Reads, writes, writebacks, extends, cache hits, evictions, fsyncs, and timing | `pg_stat_io` on PostgreSQL 16+ |
| Prometheus | Protected `/metrics` endpoint for database and MCP pool metrics | Opt-in for HTTP transport |
| Catalog | Schemas, relations, views, sequences, functions, indexes, extensions, constraints, and usage | MCP tools and resources |
| Transports | stdio, Streamable HTTP, optional legacy SSE, health, and readiness | Built in |

## MCP tools and resources

| Tool | Purpose |
| --- | --- |
| `server_info` | Server version, database identity, safeguards, limits, and pool status |
| `list_schemas` | Schemas, owners, and current-user privileges |
| `list_objects` | Tables, views, materialized views, sequences, functions, indexes, and extensions |
| `get_object_details` | Columns, constraints, indexes, statistics, and function definitions |
| `list_extensions` | Installed PostgreSQL extensions |
| `execute_sql` | One bounded, parameterized SQL statement |
| `explain_query` | PostgreSQL JSON plan with optional gated analysis |
| `diagnose_query` | Deterministic plan findings and advisory index candidates |
| `compare_query_plans` | Baseline/candidate fingerprints, deltas, and regression verdict |
| `recommend_indexes` | Existing-index-aware advice with optional HypoPG validation |
| `list_slow_queries` | `pg_stat_statements` planning, execution, cache, I/O, and WAL rankings |
| `monitor_database` | Scored health, blockers, maintenance, replication, WAL, checkpoints, I/O, archiver, and pool snapshot |
| `database_health` | Compatibility alias for `monitor_database` |

Catalog resources:

- `postgres://catalog`
- `postgres://catalog/schema/{schema}/{objectType}`
- `postgres://catalog/object/{schema}/{objectType}/{objectName}`

Tool results include `structuredContent` and a JSON text representation for client compatibility.

## Performance extensions

Enable `pg_stat_statements` for workload rankings:

```sql
CREATE EXTENSION pg_stat_statements;
```

It must also be included in PostgreSQL `shared_preload_libraries` before the server starts.

Optionally install HypoPG for session-local what-if index validation:

```sql
CREATE EXTENSION hypopg;
```

Without HypoPG, index recommendations still work but are reported as heuristic.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URI` / `POSTGRES_URL` / `DATABASE_URL` | PG environment | PostgreSQL connection URI |
| `MCP_DB_MODE` | `restricted` | `restricted` or `unrestricted` |
| `MCP_TRANSPORT` | `stdio` | `stdio`, `http`, or legacy alias `sse` |
| `MCP_HTTP_HOST` | `127.0.0.1` | HTTP bind address |
| `MCP_HTTP_PORT` | `8899` | HTTP port |
| `MCP_AUTH_TOKEN` | unset | Static bearer token, minimum 16 characters |
| `MCP_ALLOWED_HOSTS` | loopback hosts | Comma-separated Host allowlist |
| `MCP_ALLOWED_ORIGINS` | loopback origins | Comma-separated Origin allowlist |
| `MCP_ENABLE_LEGACY_SSE` | `false` | Enable deprecated `/sse` and `/messages` |
| `MCP_ENABLE_METRICS` | `false` | Expose Prometheus metrics through HTTP |
| `MCP_METRICS_PATH` | `/metrics` | Prometheus endpoint path |
| `MCP_STATEMENT_TIMEOUT_MS` | `15000` | PostgreSQL statement timeout |
| `MCP_LOCK_TIMEOUT_MS` | `3000` | PostgreSQL lock timeout |
| `MCP_QUERY_TIMEOUT_MS` | `20000` | Query and idle-transaction timeout |
| `MCP_MAX_ROWS` | `1000` | Maximum requested rows |
| `MCP_MAX_RESULT_BYTES` | `2000000` | Maximum serialized result size |
| `MCP_MAX_BODY_BYTES` | `1000000` | Maximum HTTP request size |
| `MCP_REQUEST_TIMEOUT_MS` | `60000` | Maximum HTTP request duration |
| `MCP_MAX_SESSIONS` | `100` | Maximum concurrent HTTP sessions |
| `MCP_SESSION_TTL_MS` | `1800000` | Idle HTTP session lifetime |
| `MCP_ALLOW_EXPLAIN_ANALYZE` | `false` | Permit query execution during diagnostics |
| `MCP_SSL_FALLBACK_TO_DISABLE` | `false` | Explicitly permit TLS downgrade after SSL rejection |
| `MCP_MONITOR_CONNECTION_WARN_PERCENT` | `80` | Connection warning threshold |
| `MCP_MONITOR_CONNECTION_CRITICAL_PERCENT` | `95` | Connection critical threshold |
| `MCP_MONITOR_LONG_QUERY_WARN_SECONDS` | `30` | Long-query warning threshold |
| `MCP_MONITOR_LONG_QUERY_CRITICAL_SECONDS` | `300` | Long-query critical threshold |
| `MCP_MONITOR_IDLE_TRANSACTION_WARN_SECONDS` | `60` | Idle-transaction warning threshold |
| `MCP_MONITOR_CACHE_HIT_WARN_PERCENT` | `95` | Cache-hit warning threshold |
| `MCP_MONITOR_DEAD_TUPLE_WARN_PERCENT` | `20` | Dead-tuple warning threshold |
| `MCP_MONITOR_XID_WARN_PERCENT` | `80` | Percentage of `autovacuum_freeze_max_age` that warns |
| `MCP_MONITOR_REPLICATION_LAG_WARN_BYTES` | `67108864` | Replication-lag warning threshold |
| `MCP_MONITOR_REPLICATION_LAG_CRITICAL_BYTES` | `1073741824` | Replication-lag critical threshold |

Standard `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, and TLS certificate variables are supported by `pg`.

## Testing

```bash
npm run check
npm run test:unit
podman machine start
npm run test:e2e:podman
npm pack --dry-run
```

The E2E harness provisions PostgreSQL 17 with `pg_stat_statements`, runs eight tuning, monitoring, security, stdio, HTTP, and metrics scenarios, and removes the container afterward. See the [Podman E2E runbook](docs/podman-e2e-runbook.md).

## Client documentation

- [Codex MCP configuration](https://developers.openai.com/codex/mcp/)
- [Claude Desktop local MCP servers](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
- [Claude remote custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

## License

Apache-2.0. See [LICENSE](LICENSE).
