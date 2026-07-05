# Postgres MCP Server

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/license/apache-2-0)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![npm version](https://img.shields.io/npm/v/postgres-mcp-server)](https://www.npmjs.com/package/postgres-mcp-server)
[![Last Commit](https://img.shields.io/github/last-commit/shadabshaukat/postgres-mcp-server)](https://github.com/shadabshaukat/postgres-mcp-server/commits/main)
[![Docker Pulls](https://img.shields.io/docker/pulls/9382382888/postgres-mcp-server)](https://hub.docker.com/r/9382382888/postgres-mcp-server)
[![Issues](https://img.shields.io/github/issues/shadabshaukat/postgres-mcp-server)](https://github.com/shadabshaukat/postgres-mcp-server/issues)
[![Pull Requests](https://img.shields.io/github/issues-pr/shadabshaukat/postgres-mcp-server)](https://github.com/shadabshaukat/postgres-mcp-server/pulls)
[![Stars](https://img.shields.io/github/stars/shadabshaukat/postgres-mcp-server?style=social)](https://github.com/shadabshaukat/postgres-mcp-server/stargazers)
[![Forks](https://img.shields.io/github/forks/shadabshaukat/postgres-mcp-server?style=social)](https://github.com/shadabshaukat/postgres-mcp-server/network/members)

<img width="1536" height="1024" alt="Building a server with Postgres power" src="https://github.com/user-attachments/assets/5af3c36b-7a7e-4c40-aa9b-da074205a2a2" />

<p align="center">
  <strong>Secure PostgreSQL insight for MCP clients&mdash;bounded execution, deterministic tuning, and production-grade monitoring.</strong>
</p>

<p align="center">
  <a href="#quick-start-local-postgresql-18-claude-desktop-and-codex">Quick start</a> &middot;
  <a href="#security-model">Security</a> &middot;
  <a href="#feature-matrix">Features</a> &middot;
  <a href="#mcp-tools-and-resources">Tools</a> &middot;
  <a href="#configuration-reference">Configuration</a> &middot;
  <a href="#testing">Testing</a>
</p>

A secure-by-default PostgreSQL [Model Context Protocol](https://modelcontextprotocol.io/) server with bounded SQL execution, deterministic query tuning, workload analysis, scored database monitoring, and optional Prometheus metrics.

| Safe by default | Performance-aware | Operations-ready |
| --- | --- | --- |
| Read-only transactions, query limits, timeouts, bearer authentication, and Host/Origin validation | Plan diagnosis, comparison, index advice, HypoPG validation, and `pg_stat_statements` rankings | Health scoring, blockers, maintenance pressure, replication, WAL, checkpoints, and opt-in metrics |

The server follows an enterprise-focused design:

- Clear **access modes**: `restricted` (read-only) and `unrestricted`
- A focused **tool model** for catalog discovery, bounded SQL, tuning, and monitoring
- Stable **dual transport** support: `stdio` and Streamable HTTP, with opt-in legacy SSE endpoints
- Actionable startup and runtime diagnostics for database connectivity
- Container-friendly access to local, tunneled, and remote PostgreSQL deployments

## Tested deployments

- OCI PostgreSQL
- Amazon RDS for PostgreSQL
- Amazon Aurora PostgreSQL-Compatible Edition

## Quick start: local PostgreSQL 18, Claude Desktop, and Codex

This flow starts one long-running MCP container and connects both clients to the same Streamable HTTP endpoint. PostgreSQL credentials are supplied only to the MCP container; Claude Desktop and Codex receive the MCP URL and bearer token.

The commands below match a local PostgreSQL container created as follows:

> [!WARNING]
> The `postgres` superuser and sample password below are for an isolated local walkthrough only. Use a dedicated least-privilege login and a secret manager for shared, staging, or production databases.

```bash
docker network inspect postgres-mcp-net >/dev/null 2>&1 || \
  docker network create postgres-mcp-net

docker run --name postgres18 \
  --network postgres-mcp-net \
  --env POSTGRES_PASSWORD=my_secure_password \
  --volume pg18_data:/var/lib/postgresql \
  --detach postgres:18
```

If `postgres18` already exists, do not run that command again. Confirm that it is running with `docker ps --filter name=postgres18`; use `docker start postgres18` if it is stopped. Attach an existing container to the private network once with `docker network connect postgres-mcp-net postgres18` (an “already exists” response is harmless). Because `POSTGRES_DB` was not set, the database name is `postgres`.

### 1. Requirements

| Requirement | Version or guidance |
| --- | --- |
| Container runtime | Docker for the exact commands; Podman is also supported |
| PostgreSQL | 14 or newer |
| Database account | Prefer a dedicated role with only the privileges the MCP client needs |
| Manual/npm deployment | Node.js 20 or newer |
| Claude Desktop bridge | Node.js 20.18.1 or newer with `npx` (Node.js 22 LTS recommended); not required for the MCP container or Codex |
| Shell utilities | A POSIX-compatible shell and OpenSSL for the exact token-generation commands |

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

Start the MCP server. The first line reuses `POSTGRES_MCP_TOKEN` when it is already set or generates 32 random bytes encoded as a 64-character token. The host-side `POSTGRES_MCP_TOKEN` value is passed to the container as `MCP_AUTH_TOKEN`; both sides must use the same secret.

```bash
export POSTGRES_MCP_TOKEN="${POSTGRES_MCP_TOKEN:-$(openssl rand -hex 32)}"

docker run --detach --name postgres-mcp \
  --restart unless-stopped \
  --read-only \
  --tmpfs /tmp \
  --security-opt no-new-privileges:true \
  --network postgres-mcp-net \
  --publish 127.0.0.1:8899:8899 \
  --env 'DATABASE_URI=postgresql://postgres:my_secure_password@postgres18:5432/postgres?sslmode=disable' \
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

`postgres18` resolves through the private Docker network, so PostgreSQL does not need a host-published port. The stock local `postgres:18` container does not use TLS, so this isolated container-network connection uses `sslmode=disable`. Keep `MCP_DB_MODE=restricted` unless the database role and endpoint are explicitly intended to permit writes.

For anything beyond local testing, create a dedicated least-privilege role and inject its URI through your normal secret-management process. `DATABASE_URI` and `MCP_AUTH_TOKEN` are visible to users with Docker daemon or container-inspection access.

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
| `http://127.0.0.1:8899/metrics` | Prometheus metrics | Bearer token required; disabled unless `MCP_ENABLE_METRICS=true` |

The host-side port is bound to `127.0.0.1`, so this example is reachable only from the local machine. The unauthenticated liveness and readiness endpoints return only status, but they should remain loopback-only or be protected by a reverse proxy in non-local deployments.

> [!NOTE]
> PostgreSQL 18 changed the byte-counter columns in `pg_stat_io`. In server version `0.3.0`, the core MCP, catalog, SQL, tuning, and health-scoring features work on PostgreSQL 18, but the `monitor_database.io` section reports unavailable until the query is updated for the PostgreSQL 18 column names.

### 4. Connect Codex to the running container

Codex supports Streamable HTTP directly.

> [!IMPORTANT]
> `--bearer-token-env-var` and `bearer_token_env_var` take the **name of an environment variable**, not the bearer token. Keep the token out of `config.toml`. The value of `POSTGRES_MCP_TOKEN` in the Codex process must match `MCP_AUTH_TOKEN` in the MCP container.

If an older `postgres` entry already exists, remove or rename it before registering this server. Then register it once:

```bash
codex mcp add postgres \
  --url http://127.0.0.1:8899/mcp \
  --bearer-token-env-var POSTGRES_MCP_TOKEN

codex mcp list
```

Alternatively, configure the same server directly in `~/.codex/config.toml`:

```toml
[mcp_servers.postgres]
url = "http://127.0.0.1:8899/mcp"
bearer_token_env_var = "POSTGRES_MCP_TOKEN"
startup_timeout_sec = 30
tool_timeout_sec = 120
```

The string `"POSTGRES_MCP_TOKEN"` above is the variable name. Never replace it with the token itself or store an `Authorization` header directly in `config.toml`.

#### Start Codex with the token

The Codex app, CLI, and IDE extension share MCP configuration, but a running process does not retroactively acquire new environment variables.

##### Codex CLI

Start Codex from a shell that has the token:

```bash
export POSTGRES_MCP_TOKEN="$(docker exec postgres-mcp printenv MCP_AUTH_TOKEN)"
codex
unset POSTGRES_MCP_TOKEN
```

##### Codex app on macOS

Completely quit Codex with <kbd>Cmd</kbd>+<kbd>Q</kbd>, then launch a fresh instance with the token scoped to that app process:

```bash
POSTGRES_MCP_TOKEN="$(docker exec postgres-mcp printenv MCP_AUTH_TOKEN)"
open -na "Codex" --env "POSTGRES_MCP_TOKEN=$POSTGRES_MCP_TOKEN"
unset POSTGRES_MCP_TOKEN
```

<details>
<summary>Optional: launch Codex from the Dock for the current macOS login session</summary>

```bash
launchctl setenv POSTGRES_MCP_TOKEN "$(docker exec postgres-mcp printenv MCP_AUTH_TOKEN)"
```

This makes the value available more broadly than the process-scoped launch, so use it only when Dock launches are required. Completely quit and reopen Codex. Remove the login-session value when it is no longer needed:

```bash
launchctl unsetenv POSTGRES_MCP_TOKEN
```

</details>

##### Codex IDE extension

Completely quit the editor, then launch it from a shell containing the token. Replace `code` with the appropriate launcher for your editor:

```bash
export POSTGRES_MCP_TOKEN="$(docker exec postgres-mcp printenv MCP_AUTH_TOKEN)"
code .
unset POSTGRES_MCP_TOKEN
```

After changing the environment, relaunch the client and start a new thread or session. In the Codex CLI, `/mcp` confirms the live connection; in the Codex app, review **Settings > Integrations & MCP**. `codex mcp list` confirms saved configuration only—it does not prove authentication succeeded.

### 5. Connect Claude Desktop to the running container

Claude Desktop's local MCP configuration expects a local process definition. The `mcp-remote` bridge adapts that local stdio connection to the container's Streamable HTTP endpoint. Do not use a cloud-hosted remote connector for `127.0.0.1`; a cloud service cannot reach a server on your computer.

On macOS, copy the token without printing it to the terminal:

```bash
printf '%s' "$POSTGRES_MCP_TOKEN" | pbcopy
```

On other platforms, copy the value using your normal secret-management workflow.

Open **Claude Desktop > Settings > Developer > Edit Config**. The configuration file is normally:

| Platform | File |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Merge this server into the existing top-level `mcpServers` object, replacing `paste-the-token-from-step-3` with the token value:

> [!WARNING]
> Claude Desktop stores the value in its local configuration file. Never commit or share that file. If a real token is ever committed, posted, or logged, rotate it immediately.

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

`AUTH_HEADER` is the complete HTTP authorization value and must start with `Bearer `; the raw token by itself will be rejected. `--allow-http` is appropriate here only because the server is bound to the local loopback interface, and `--transport http-only` selects the server's Streamable HTTP transport. Keep `Authorization:${AUTH_HEADER}` without spaces around the colon; this avoids argument parsing problems on some Claude Desktop installations.

> [!TIP]
> `npx -y mcp-remote` may download the current package at launch. For repeatable environments, replace `mcp-remote` with a version you have reviewed and pinned, for example `mcp-remote@<reviewed-version>`.

Verify that `npx` is available:

```bash
npx --version
```

If `npx` is not found, replace `"command": "npx"` with its absolute path (`command -v npx` on macOS/Linux or `where npx` on Windows). On a Homebrew-based macOS installation, repair a broken Node/npx dynamic-library installation with `brew reinstall node`.

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
export POSTGRES_MCP_TOKEN="${POSTGRES_MCP_TOKEN:-$(openssl rand -hex 32)}"
export MCP_AUTH_TOKEN="$POSTGRES_MCP_TOKEN"
docker compose --file docker-compose.example.yml up --detach --build
```

The Compose file passes `MCP_AUTH_TOKEN` to the server; Codex reads the same secret from `POSTGRES_MCP_TOKEN`. Use `podman compose` instead when a Podman Compose provider is installed.

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

Register the manual build with Codex without storing the database password in `config.toml`. First export `DATABASE_URI` in the environment that will launch Codex, then add this configuration:

```toml
[mcp_servers.postgres-npm]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/postgres-mcp-server/build/index.js"]
env_vars = ["DATABASE_URI"]

[mcp_servers.postgres-npm.env]
MCP_TRANSPORT = "stdio"
MCP_DB_MODE = "restricted"
```

For Claude Desktop, replace the earlier `mcp-remote` entry with a local stdio definition: set `command` to the absolute path of `node`, set `args` to the absolute `build/index.js` path, and put `DATABASE_URI` plus `MCP_TRANSPORT=stdio` in `env`. That local configuration will contain the database secret, so never commit or share it.

Run a loopback HTTP server manually:

```bash
DATABASE_URI='postgres://mcp_reader:password@127.0.0.1:5432/app?sslmode=disable' \
MCP_TRANSPORT=http \
MCP_HTTP_HOST=127.0.0.1 \
MCP_AUTH_TOKEN='replace-with-a-long-random-token' \
node build/index.js
```

## Security model

`restricted` is the default mode. Every user query runs inside a PostgreSQL `READ ONLY` transaction with server-controlled statement, lock, row, and response-size limits. SQL inspection provides early feedback, while PostgreSQL permissions, row-level security, and transaction semantics remain the enforcement boundary.

| Boundary | Guidance |
| --- | --- |
| PostgreSQL role | Use a dedicated least-privilege role; add `pg_monitor` only when broader monitoring visibility is required |
| `MCP_DB_MODE=unrestricted` | Permits writes; use only for a tightly controlled role and endpoint |
| `EXPLAIN ANALYZE` | Executes the query; disabled unless `MCP_ALLOW_EXPLAIN_ANALYZE=true` |
| HTTP exposure | Non-loopback binding requires a bearer token and explicit allowed hosts unless the isolated-development-only `MCP_ALLOW_INSECURE_HTTP=true` override is set |
| Liveness/readiness | `/healthz` and `/readyz` are intentionally unauthenticated; keep them private or protect them at a reverse proxy |
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
| Workload statistics | Calls, planning totals/means, execution variance, rows, cache activity, temporary I/O, I/O timing, WAL, role, and reset metadata | Requires `pg_stat_statements`; some fields depend on PostgreSQL tracking settings |
| Health scoring | Configurable connection, duration, cache, dead-tuple, XID-age, and replication-lag thresholds, plus built-in lock and pool findings | Built in |
| Activity and locks | Long queries, idle transactions, lock waits, and blocker graph | Visibility follows PostgreSQL role privileges |
| Maintenance | Tuple health, scan mix, analyze/vacuum history, XID age, and table size | Built in |
| Physical replication and durability | Sender or receiver state, replay lag, WAL, checkpoints, restartpoints, and archiver status | Version and primary/standby-role aware |
| PostgreSQL I/O | Reads, writes, writebacks, extends, cache hits, evictions, fsyncs, and timing | PostgreSQL 16–17 in version `0.3.0`; PostgreSQL 18 byte-counter support is pending |
| Prometheus | `/metrics` endpoint for database and MCP pool metrics | Opt-in for HTTP transport; uses the configured HTTP security controls |
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

Successful tool results include `structuredContent` and a JSON text representation for client compatibility.

## Performance extensions

To enable `pg_stat_statements` workload rankings:

1. Add `pg_stat_statements` to `shared_preload_libraries` while preserving any existing entries.
2. Restart PostgreSQL.
3. Create the extension in each database you want to inspect:

```sql
CREATE EXTENSION pg_stat_statements;
```

Enable `pg_stat_statements.track_planning` when planning metrics are required and `track_io_timing` when read/write timing is required. A least-privilege MCP role sees only the statistics PostgreSQL permits; grant `pg_read_all_stats` or the broader `pg_monitor` role only when cross-session visibility is necessary.

Optionally install HypoPG for session-local what-if index validation:

```sql
CREATE EXTENSION hypopg;
```

Without HypoPG, index recommendations still work but are reported as heuristic.

## Configuration reference

The defaults below are the source/npm defaults. The container image overrides `MCP_TRANSPORT=http` and `MCP_HTTP_HOST=0.0.0.0`; secure non-loopback startup therefore also requires a bearer token and explicit allowed hosts. The example Compose file supplies those values.

### Connection and execution

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URI` / `POSTGRES_URL` / `DATABASE_URL` | PostgreSQL environment | Connection URI, checked in this order |
| `MCP_DB_MODE` | `restricted` | `restricted` or `unrestricted` database access mode |
| `MCP_TRANSPORT` | `stdio` (container: `http`) | `stdio` or `http`; `sse` is a legacy alias for HTTP mode |
| `MCP_AUTO_REMAP_LOCALHOST` | `true` | Remap a URI using `localhost` to the container host alias when running in a container |
| `MCP_CONTAINER_HOST_ALIAS` | Runtime-specific | Override `host.docker.internal` or `host.containers.internal` |
| `PGPOOL_MAX` | `10` | Maximum PostgreSQL pool size |
| `PGPOOL_IDLE_TIMEOUT_MS` | `30000` | Idle pooled-connection timeout |
| `PGPOOL_CONNECTION_TIMEOUT_MS` | `10000` | New PostgreSQL connection timeout |
| `MCP_STATEMENT_TIMEOUT_MS` | `15000` | PostgreSQL statement timeout |
| `MCP_LOCK_TIMEOUT_MS` | `3000` | PostgreSQL lock timeout |
| `MCP_QUERY_TIMEOUT_MS` | `20000` | Application query and idle-transaction deadline |
| `MCP_MAX_ROWS` | `1000` | Maximum requested rows |
| `MCP_MAX_RESULT_BYTES` | `2000000` | Maximum serialized result size |
| `MCP_ALLOW_EXPLAIN_ANALYZE` | `false` | Permit execution during plan diagnostics |

### HTTP transport and security

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_HTTP_HOST` | `127.0.0.1` (container: `0.0.0.0`) | HTTP bind address |
| `MCP_HTTP_PORT` | `8899` | HTTP port |
| `MCP_HTTP_PATH` | `/mcp` | Streamable HTTP MCP endpoint |
| `MCP_AUTH_TOKEN` | Unset | Static bearer token; minimum 16 characters, with 32 random bytes recommended |
| `MCP_ALLOWED_HOSTS` | Loopback list when bound to loopback; otherwise empty | Comma-separated Host allowlist; required for secure non-loopback binding |
| `MCP_ALLOWED_ORIGINS` | Loopback origins when bound to loopback; otherwise empty | Comma-separated browser Origin allowlist |
| `MCP_ALLOW_INSECURE_HTTP` | `false` | Bypass non-loopback token/Host requirements for an isolated development network only |
| `MCP_MAX_BODY_BYTES` | `1000000` | Maximum HTTP request body size |
| `MCP_REQUEST_TIMEOUT_MS` | `60000` | Maximum HTTP request duration |
| `MCP_MAX_SESSIONS` | `100` | Maximum concurrent HTTP sessions |
| `MCP_SESSION_TTL_MS` | `1800000` | Idle HTTP session lifetime |
| `MCP_ENABLE_METRICS` | `false` | Expose Prometheus metrics through HTTP |
| `MCP_METRICS_PATH` | `/metrics` | Prometheus endpoint path |
| `MCP_ENABLE_LEGACY_SSE` | `false` | Enable deprecated SSE endpoints |
| `MCP_LEGACY_SSE_PATH` | `/sse` | Legacy SSE stream path |
| `MCP_LEGACY_MESSAGES_PATH` | `/messages` | Legacy SSE message path |

When changing `MCP_HTTP_PORT`, update `MCP_ALLOWED_ORIGINS` to use the same port. Metrics and legacy SSE use the same configured Host, Origin, and bearer-token controls as the main MCP endpoint.

### TLS

| Variable | Default | Meaning |
| --- | --- | --- |
| `PGSSLMODE` | Unset (Compose: `require`) | `disable`, `allow`, `prefer`, `require`, `verify-ca`, or `verify-full` |
| `PGSSLREJECTUNAUTHORIZED` | Mode-dependent | Defaults to `true` for `verify-ca`/`verify-full` and `false` otherwise |
| `PGSSLROOTCERT` / `PGSSLROOTCERT_PATH` | Unset | CA certificate content or file path |
| `PGSSLCERT` / `PGSSLCERT_PATH` | Unset | Client certificate content or file path |
| `PGSSLKEY` / `PGSSLKEY_PATH` | Unset | Client key content or file path |
| `MCP_SSL_FALLBACK_TO_DISABLE` | `false` | Explicitly permit a TLS downgrade after SSL rejection |

Standard `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` variables are supported when no connection URI is supplied.

### Monitoring thresholds

| Variable | Default | Meaning |
| --- | --- | --- |
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
