# Postgres MCP Server (Rebuilt)

This project was rebuilt to follow a more proven Postgres-MCP style design:

- Clear **access modes**: `restricted` (safe/read-only oriented) and `unrestricted`
- Clean **tool model** for schema/object discovery and SQL execution
- Stable **dual transport** support: `stdio` and Streamable HTTP (`sse`)
- Better startup/runtime diagnostics for DB connectivity
- Docker-focused remote DB usage (including host SSH tunnel pattern)

---

## Features

### Tools

1. `server_info`
2. `list_schemas`
3. `list_objects`
4. `get_object_details`
5. `list_extensions`
6. `execute_sql`

### Access modes

- `restricted` (default):
  - allows only safe read-style SQL (`SELECT`, `WITH`, `SHOW`, `EXPLAIN`)
  - blocks obvious unsafe keywords (`commit`, `rollback`, `begin`, `drop`, `alter`, `create`, `copy`)
  - enforces single-statement behavior
  - applies bounded row limit wrapping for `SELECT`/`WITH`

- `unrestricted`:
  - passes SQL through to Postgres directly

### Transport modes

- `stdio` (default if not specified)
- `sse` (Streamable HTTP endpoint, default path `/mcp`)

---

## Environment Variables

### Connection

Use one of:

- `DATABASE_URI` (preferred)
- `POSTGRES_URL`
- `DATABASE_URL`

Or use PG envs (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`).

### MCP runtime

- `MCP_TRANSPORT=stdio|sse`
- `MCP_DB_MODE=restricted|unrestricted`
- `MCP_HTTP_HOST` (default `0.0.0.0`)
- `MCP_HTTP_PORT` (default `8899`)
- `MCP_HTTP_PATH` (default `/mcp`)

### Helpful behavior switches

- `MCP_AUTO_REMAP_LOCALHOST=true|false` (default `true`)
  - If running inside Docker and connection host is `localhost`/`127.0.0.1`, rewrites host to `host.docker.internal` (or alias below).
- `MCP_DOCKER_HOST_ALIAS` (default `host.docker.internal`)
- `NODE_NO_WARNINGS=1` (default in Docker/compose examples)
  - suppresses Node runtime warnings in container logs.
  - set `NODE_NO_WARNINGS=0` if you want warnings visible.

### SSL

- `PGSSLMODE`
- `PGSSLREJECTUNAUTHORIZED`
- `PGSSLROOTCERT_PATH` / `PGSSLROOTCERT`
- `PGSSLCERT_PATH` / `PGSSLCERT`
- `PGSSLKEY_PATH` / `PGSSLKEY`
- `MCP_SSL_FALLBACK_TO_DISABLE=true|false` (default `true`)
  - If server detects `does not support SSL connections`, it retries once with `sslmode=disable`.

---

## Special Character Passwords (fixed)

You can provide raw special characters in URI credentials, for example:

`<db_password_with_special_chars>`

The server normalizes/encodes URI credentials internally before connecting.

---

## Startup Log Behavior (fixed)

When DB connection succeeds, container/console logs include a detailed line like:

- `Database connected successfully | db=... | user=... | host=... | port=... | ...`

Connection password is masked in logs (`******`).

---

## Local Run

Install and build:

```bash
npm install
npm run build
```

Run SSE:

```bash
MCP_TRANSPORT=sse MCP_HTTP_PORT=8899 MCP_DB_MODE=restricted DATABASE_URI='postgres://<db_user>:<db_password>@<db_host>:5432/<db_name>?sslmode=require' node build/index.js
```

Run stdio:

```bash
MCP_TRANSPORT=stdio MCP_DB_MODE=restricted DATABASE_URI='postgres://<db_user>:<db_password>@<db_host>:5432/<db_name>?sslmode=require' node build/index.js
```

---

## Docker Run (App in Docker, DB remote)

> Architecture: MCP app runs in Docker, Postgres stays remote.

Build:

```bash
docker build -t postgres-mcp-server:latest .
```

Run:

```bash
docker run --rm -p 8899:8899 \
  -e MCP_TRANSPORT=sse \
  -e MCP_HTTP_HOST=0.0.0.0 \
  -e MCP_HTTP_PORT=8899 \
  -e MCP_HTTP_PATH=/mcp \
  -e MCP_DB_MODE=restricted \
  -e DATABASE_URI='postgres://<db_user>:<db_password>@host.docker.internal:5432/<db_name>?sslmode=require' \
  postgres-mcp-server:latest
```

---

## Remote DB via SSH Tunnel (host machine)

If you forward remote DB to host `localhost:5432`:

```bash
ssh -fNT -L 5432:<remote_db_private_ip>:5432 <ssh_user>@<ssh_bastion_host> -i /absolute/path/to/private_key
```

Then from Docker app, use:

- `host.docker.internal:5432`

not `localhost:5432`.

---

## Client Config (Corrected for compatibility)

### Claude Desktop (recommended)

Claude Desktop commonly requires stdio-style MCP server definitions (not raw `url`).

Use:

```json
{
  "mcpServers": {
    "postgres-sse": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:8899/mcp"
      ]
    }
  }
}
```

### VS Code Cline

#### Option A: Legacy SSE mode (most compatible)

```json
{
  "mcpServers": {
    "postgres-sse": {
      "type": "sse",
      "url": "http://127.0.0.1:8899/sse",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

#### Option B: Streamable HTTP mode (newer clients)

```json
{
  "mcpServers": {
    "postgres-sse": {
      "url": "http://127.0.0.1:8899/mcp",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

> This server now supports **both** endpoints:
> - Streamable HTTP: `/mcp`
> - Legacy SSE: `/sse` with message POST endpoint `/messages`

---

## Docker Compose

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up --build
```

---

## Troubleshooting

### 1) `Could not attach` / HTTP 500 from bridge

Check:

- server log shows DB connected successfully
- server log shows SSE endpoint at `/mcp`
- client URL is exactly `http://127.0.0.1:8899/mcp`
- no port collision on `8899`

### 1b) `SSE error: Non-200 status code (400)` in Cline

Usually means the client is using legacy SSE protocol against `/mcp`.

Fix by using Cline legacy SSE config:

- `"type": "sse"`
- `"url": "http://127.0.0.1:8899/sse"`

or switch to a newer client build that supports Streamable HTTP `/mcp`.

### 1c) Claude says config is invalid and skips server

Claude Desktop likely rejected `url` style config.

Use stdio-style bridge config (`command` + `args`) with `mcp-remote`.

### 1d) Errors like `Server not initialized` / `Server already initialized` / `Mcp-Session-Id header is required`

These were due to session-routing behavior in older builds.

Fix:

- rebuild image from latest code:

```bash
docker build --no-cache -t postgres-mcp-server:latest .
```

- restart container and reconnect Claude/Cline.

### 2) Docker cannot reach Postgres

- use `host.docker.internal` for host-side tunnel endpoints
- ensure tunnel is active before starting container

### 3) `The server does not support SSL connections`

This means your target Postgres endpoint is plain TCP (non-SSL) while URI requested SSL.

Options:

- Use `?sslmode=disable` directly in `DATABASE_URI`, or
- Keep current URI and rely on automatic one-time fallback (enabled by default):
  - `MCP_SSL_FALLBACK_TO_DISABLE=true`

If you want strict behavior (no fallback), set:

```bash
-e MCP_SSL_FALLBACK_TO_DISABLE=false
```

### 4) Port already allocated

Either stop process using 8899 or run with another port:

```bash
docker run --rm -p 9900:8899 ...
```

Then client URL becomes:

- `http://127.0.0.1:9900/mcp`

---

## Scripts

```bash
npm run build
npm run dev
npm run start
npm run start:sse
npm run start:stdio
```
