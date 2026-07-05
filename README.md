# Postgres MCP Server 

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/license/apache-2-0)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![npm version](https://img.shields.io/npm/v/postgres-mcp-server)](https://www.npmjs.com/package/postgres-mcp-server)
[![Last Commit](https://img.shields.io/github/last-commit/shadabshaukat/postgres-mcp-server)](https://github.com/shadabshaukat/postgres-mcp-server/commits/main)
[![Docker Pulls](https://img.shields.io/docker/pulls/9382382888/postgres-mcp-server)](https://hub.docker.com/r/9382382888/postgres-mcp-server)
[![Issues](https://img.shields.io/github/issues/shadabshaukat/postgres-mcp-server)](https://github.com/shadabshaukat/postgres-mcp-server/issues)
[![Pull Requests](https://img.shields.io/github/issues-pr/shadabshaukat/postgres-mcp-server)](https://github.com/shadabshaukat/postgres-mcp-server/pulls)
[![Stars](https://img.shields.io/github/stars/shadabshaukat/postgres-mcp-server?style=social)](https://github.com/shadabshaukat/postgres-mcp-server/stargazers)
[![Forks](https://img.shields.io/github/forks/shadabshaukat/postgres-mcp-server?style=social)](https://github.com/shadabshaukat/postgres-mcp-server/network/members)

<img width="1536" height="1024" alt="Building a server with Postgres power" src="https://github.com/user-attachments/assets/5af3c36b-7a7e-4c40-aa9b-da074205a2a2" />


A secure PostgreSQL Model Context Protocol server with bounded SQL execution, deterministic query tuning, workload analysis, scored database monitoring, and Prometheus metrics.


This project was built to follow a more Enterprise Postgres-MCP style design:

- Clear **access modes**: `restricted` (safe/read-only oriented) and `unrestricted`
- Clean **tool model** for schema/object discovery and SQL execution
- Stable **dual transport** support: `stdio` and Streamable HTTP (`sse`)
- Better startup/runtime diagnostics for DB connectivity
- Docker-focused remote DB usage (including host SSH tunnel pattern)

## Tested On
- OCI PostgreSQL 
- Amazon RDS PostgreSQL 
- Amazon Aurora PostgreSQL 

## Quick start: local PostgreSQL 18, Claude Desktop, and Codex

This flow starts one long-running MCP container and connects both clients to the same Streamable HTTP endpoint. PostgreSQL credentials are supplied only to the MCP container; Claude Desktop and Codex receive the MCP URL and bearer token.

The commands below match a local PostgreSQL container created as follows:

```bash
docker run --name postgres18 \
  --env POSTGRES_PASSWORD=my_secure_password \
  --publish 5432:5432 \
  --volume pg18_data:/var/lib/postgresql \
  --detach postgres:18
```

If `postgres18` already exists, do not run that command again. Confirm that it is running with `docker ps --filter name=postgres18`; use `docker start postgres18` if it is stopped. Because `POSTGRES_DB` was not set, the database name is `postgres`.

### 1. Requirements

| Requirement | Version or guidance |
| --- | --- |
| Container runtime | Docker Desktop for the exact local example; Docker or Podman for other deployments |
| PostgreSQL | 14 or newer |
| Database account | Prefer a dedicated role with only the privileges the MCP client needs |
| Claude Desktop bridge | Node.js 18 or newer with `npx`; not required for the MCP container or Codex |

Clone the repository and enter it:

```bash
git clone https://github.com/shadabshaukat/postgres-mcp-server.git
cd postgres-mcp-server
```

### 2. Build the MCP image

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

### 3. Launch the MCP container with PostgreSQL credentials

If an earlier attempt created a stopped container with the same name, remove only that failed MCP container before retrying:

```bash
docker rm postgres-mcp
```

Start the MCP server. The first line reuses `POSTGRES_MCP_TOKEN` when it is already set or generates a new 64-character token. Save the printed value somewhere secure because Codex and Claude Desktop must use the same token.

```bash
export POSTGRES_MCP_TOKEN="${POSTGRES_MCP_TOKEN:-$(openssl rand -hex 32)}"
printf 'Save this MCP token: %s\n' "$POSTGRES_MCP_TOKEN"

docker run --detach --name postgres-mcp \
  --publish 127.0.0.1:8899:8899 \
  --env 'DATABASE_URI=postgresql://postgres:my_secure_password@host.docker.internal:5432/postgres?sslmode=disable' \
  --env PGSSLMODE=disable \
  --env MCP_TRANSPORT=http \
  --env MCP_HTTP_HOST=0.0.0.0 \
  --env MCP_HTTP_PORT=8899 \
  --env MCP_HTTP_PATH=/mcp \
  --env MCP_DB_MODE=restricted \
  --env "MCP_AUTH_TOKEN=${POSTGRES_MCP_TOKEN:?POSTGRES_MCP_TOKEN is not set}" \
  --env 'MCP_ALLOWED_HOSTS=localhost,127.0.0.1' \
  --env 'MCP_ALLOWED_ORIGINS=http://localhost:8899,http://127.0.0.1:8899' \
  postgres-mcp-server:latest
```

`host.docker.internal` is intentional: `localhost` inside the MCP container would refer to the MCP container itself. The stock local `postgres:18` container does not use TLS, so this trusted local connection uses `sslmode=disable`. Keep `MCP_DB_MODE=restricted` unless the database role and endpoint are explicitly intended to permit writes.

The `postgres` superuser and sample password are used here only to match this local walkthrough. For anything beyond local testing, create a dedicated least-privilege role and inject its URI through your normal secret-management process; Docker environment variables are visible in container metadata.

Check the startup log and database readiness:

```bash
docker logs postgres-mcp
curl http://127.0.0.1:8899/readyz
```

The readiness response should be `{"status":"ready"}`. If the MCP container exited, `docker logs postgres-mcp` reports the database connection or configuration error.

The running container serves:

| Endpoint | Purpose | Authentication |
| --- | --- | --- |
| `http://127.0.0.1:8899/mcp` | Streamable HTTP MCP | Bearer token required |
| `http://127.0.0.1:8899/healthz` | Process liveness | None |
| `http://127.0.0.1:8899/readyz` | PostgreSQL readiness | None |
| `http://127.0.0.1:8899/metrics` | Prometheus metrics | Available only when `MCP_ENABLE_METRICS=true` |

The host-side port is bound to `127.0.0.1`, so this example is reachable only from the local machine.

### 4. Connect Codex to the running container

Codex supports Streamable HTTP directly. In the same shell where `POSTGRES_MCP_TOKEN` is set, run:

```bash
codex mcp add postgres \
  --url http://127.0.0.1:8899/mcp \
  --bearer-token-env-var POSTGRES_MCP_TOKEN

codex mcp list
```

The Codex app, CLI, and IDE extension share this MCP configuration. Make `POSTGRES_MCP_TOKEN` available in the environment whenever Codex starts, then start a new session. In the CLI, `/mcp` shows the connected server; in the Codex app, review **Settings > Integrations & MCP**.

You can configure the same server directly in `~/.codex/config.toml`:

```toml
[mcp_servers.postgres]
url = "http://127.0.0.1:8899/mcp"
bearer_token_env_var = "POSTGRES_MCP_TOKEN"
startup_timeout_sec = 30
tool_timeout_sec = 120
```

If a GUI-launched Codex app cannot inherit `POSTGRES_MCP_TOKEN`, replace `bearer_token_env_var` with `http_headers = { Authorization = "Bearer paste-the-token-from-step-3" }`. This is simpler but stores the token in plain text in `config.toml`.

If an older `postgres` entry already exists, remove or rename it before adding this one.

### 5. Connect Claude Desktop to the running container

Claude Desktop's local MCP configuration expects a local process definition. The `mcp-remote` bridge from the previously working README configuration adapts the local stdio connection to the container's Streamable HTTP endpoint. Do not use Claude's cloud-hosted remote connector for `127.0.0.1`; Anthropic's cloud cannot reach a server on your computer.

Print the token from step 3 and copy its value:

```bash
printf '%s\n' "$POSTGRES_MCP_TOKEN"
```

Open **Claude Desktop > Settings > Developer > Edit Config**. The configuration file is normally:

| Platform | File |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Merge this server into the existing top-level `mcpServers` object, replacing `paste-the-token-from-step-3` with the token value:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:8899/mcp",
        "--allow-http",
        "--transport",
        "http-only",
        "--header",
        "Authorization:${AUTH_HEADER}"
      ],
      "env": {
        "AUTH_HEADER": "Bearer paste-the-token-from-step-3"
      }
    }
  }
}
```

eg:

```
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:8899/mcp",
        "--allow-http",
        "--transport",
        "http-only",
        "--header",
        "Authorization:${AUTH_HEADER}"
      ],
      "env": {
        "AUTH_HEADER": "Bearer 6ef58649864f1c10fec31f66dfcb3f3b33b2cb356597c746159405615fd7efb5"
      }
    }
  }
```

`AUTH_HEADER` is the complete HTTP authorization value and must start with `Bearer `; the raw token by itself will be rejected. `--allow-http` is appropriate here only because the server is bound to the local loopback interface, and `--transport http-only` selects the server's Streamable HTTP transport. Keep `Authorization:${AUTH_HEADER}` without spaces around the colon; this avoids argument parsing problems on some Claude Desktop installations.

Verify that Claude can start the bridge:

```bash
npx --version
```

If `npx` is not found, replace `"command": "npx"` with the absolute path returned by `command -v npx`. On a Homebrew-based macOS installation, repair a broken Node/npx dynamic-library installation with `brew reinstall node`.

Completely quit and restart Claude Desktop, then open **+ > Connectors** in a conversation and confirm that `postgres` and its tools are available.

### Database host from the MCP container

The database hostname is resolved from inside the MCP container:

| Database location | Hostname in `DATABASE_URI` |
| --- | --- |
| PostgreSQL published on a Docker Desktop host | `host.docker.internal` |
| PostgreSQL published on a Podman host | `host.containers.internal` |
| PostgreSQL in the same user-defined container network | Its container or Compose service name |
| Remote PostgreSQL | Its normal DNS name or IP address |

For a different database, replace only `DATABASE_URI` and the related TLS setting in the launch command. Percent-encode reserved characters in URI usernames and passwords. Use `sslmode=require` or `sslmode=verify-full` for remote databases; use `sslmode=disable` only for a trusted local database that does not support TLS.

For Podman, replace `docker` with `podman` and `host.docker.internal` with `host.containers.internal`. For a public deployment, terminate TLS at a trusted reverse proxy and use an OAuth-aware identity layer instead of exposing this static-token endpoint directly.

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

For Claude Desktop, replace the earlier `mcp-remote` entry with a local stdio definition: set `command` to the absolute path of `node`, set `args` to the absolute `build/index.js` path, and put `DATABASE_URI` plus `MCP_TRANSPORT=stdio` in `env`.

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
