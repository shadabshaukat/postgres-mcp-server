# Postgres MCP Server

Enterprise-oriented MCP server for PostgreSQL with:

- User table and view exploration
- System catalog exploration (`pg_catalog`)
- Controlled custom SQL execution
- Access modes (`read-only` / `read-write`)
- Dual transport support: **SSE/HTTP** and **stdio**
- Docker-first deployment with cloud SSL/TLS options

---

## What’s new

- ✅ Dual transport support implemented:
  - `MCP_TRANSPORT=sse` (HTTP endpoint, default in Docker examples)
  - `MCP_TRANSPORT=stdio` (best for local desktop process integrations)
- ✅ Runtime access control:
  - `read-only` mode allows only `SELECT`
  - `read-write` mode allows `SELECT`, `INSERT`, `UPDATE`, `DELETE`

---

## Tools exposed

1. `server_info`
2. `list_schemas`
3. `list_user_tables`
4. `query_user_table`
5. `describe_relation`
6. `list_views`
7. `query_view`
8. `list_system_catalogs`
9. `query_system_catalog`
10. `list_extensions`
11. `execute_sql`

Safety controls include identifier validation, row limits for table/view/catalog reads, and query-mode restrictions for custom SQL.

---

## Transport modes (detailed)

## 1) SSE/HTTP mode (`MCP_TRANSPORT=sse`)

Server runs an HTTP endpoint (default `/mcp`) using MCP Streamable HTTP transport.

### Advantages
- Better for centralized deployment (Docker/K8s/VM).
- Works well behind reverse proxies/load balancers.
- Easier ops observability (HTTP logs, health checks, ingress controls).
- Lets clients connect remotely without local process execution.

### Tradeoffs
- Requires network + TLS + auth hardening.
- More deployment complexity than local stdio.

## 2) stdio mode (`MCP_TRANSPORT=stdio`)

Server communicates over stdin/stdout directly with the MCP host process.

### Advantages
- Simplest for local Claude Desktop/Cline workflows.
- No network listener required.
- Smaller attack surface in local-only usage.

### Tradeoffs
- Harder to share one server instance across clients.
- Not ideal for centralized remote deployments.

---

## Access modes

- `MCP_DB_MODE=read-only` (default): only `SELECT`
- `MCP_DB_MODE=read-write`: `SELECT`, `INSERT`, `UPDATE`, `DELETE`

`execute_sql` enforces single-statement behavior and mode restrictions.

---

## Prerequisites

- Node.js 18+ (tested on Node 22)
- Reachable PostgreSQL instance

---

## Environment variables

### Database connection

Use either:

- `POSTGRES_URL` (preferred), or
- `DATABASE_URL`, or
- Individual PG vars (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`)

### Transport

- `MCP_TRANSPORT=stdio|sse`
- `MCP_HTTP_HOST` (default `0.0.0.0`)
- `MCP_HTTP_PORT` (default `8080`)
- `MCP_HTTP_PATH` (default `/mcp`)

### Access mode

- `MCP_DB_MODE=read-only|read-write`

### SSL/TLS (cloud Postgres)

- `PGSSLMODE` (`require`, `verify-ca`, `verify-full`, `prefer`, `allow`)
- `PGSSLREJECTUNAUTHORIZED` (`true|false`)
- `PGSSLROOTCERT_PATH` or `PGSSLROOTCERT` (path or inline PEM)
- `PGSSLCERT_PATH` or `PGSSLCERT` (path or inline PEM)
- `PGSSLKEY_PATH` or `PGSSLKEY` (path or inline PEM)

This supports managed providers such as AWS RDS/Aurora, Azure Database for PostgreSQL, and GCP Cloud SQL.

---

## Local development (Node)

Install/build:

```bash
npm install
npm run build
```

Run in SSE mode (recommended for remote clients):

```bash
MCP_TRANSPORT=sse MCP_HTTP_PORT=8080 MCP_DB_MODE=read-only POSTGRES_URL='postgres://user:pass@host:5432/db?sslmode=require' node build/index.js
```

Run in stdio mode (recommended for local desktop MCP):

```bash
MCP_TRANSPORT=stdio MCP_DB_MODE=read-only POSTGRES_URL='postgres://user:pass@host:5432/db?sslmode=require' node build/index.js
```

NPM shortcuts:

```bash
npm run start:sse
npm run start:stdio
```

---

## Docker (default examples use SSE)

Build image:

```bash
docker build -t postgres-mcp-server:latest .
```

Run SSE mode (default transport):

```bash
docker run --rm -p 8080:8080 \
  -e MCP_TRANSPORT=sse \
  -e MCP_HTTP_HOST=0.0.0.0 \
  -e MCP_HTTP_PORT=8080 \
  -e MCP_HTTP_PATH=/mcp \
  -e MCP_DB_MODE=read-only \
  -e POSTGRES_URL='postgres://user:pass@host:5432/db?sslmode=require' \
  postgres-mcp-server:latest
```

Run stdio mode in Docker:

```bash
docker run --rm -i \
  -e MCP_TRANSPORT=stdio \
  -e MCP_DB_MODE=read-only \
  -e POSTGRES_URL='postgres://user:pass@host:5432/db?sslmode=require' \
  postgres-mcp-server:latest
```

Compose example:

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up --build
```

---

## Claude Desktop snippet

Default deployment mode for this server is **SSE/HTTP**.
Claude Desktop often expects stdio process servers, so for SSE endpoints use an MCP bridge client.

SSE-enabled Claude Desktop snippet (via `mcp-remote` bridge):

```json
{
  "mcpServers": {
    "postgres-sse": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:8080/mcp"
      ]
    }
  }
}
```

---

## VS Code Cline snippet

Settings file:

`/Users/shadab/Library/Application Support/Code/User/globalStorage/shadab/settings/cline_mcp_settings.json`

Default deployment mode for this server is **SSE/HTTP**.
For Cline, use an MCP bridge when your backend server is exposed over SSE/HTTP.

SSE-enabled Cline snippet (via `mcp-remote` bridge):

```json
{
  "mcpServers": {
    "postgres-sse": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:8080/mcp"
      ],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

> If your client version supports native Streamable HTTP MCP server URLs directly, you can connect to `http://127.0.0.1:8080/mcp` without a bridge.

---

## Enterprise feature gap assessment (what can be added next)

Current server is solid for read/query/catalog workflows, but enterprise teams often also add:

1. **AuthN/AuthZ layers for HTTP mode**
   - API keys/JWT/OIDC
   - tenant scoping and role-based tool access

2. **Audit and governance**
   - immutable query audit logs
   - sensitive column masking / row-level policy enforcement

3. **Secret management integrations**
   - Vault / AWS Secrets Manager / Azure Key Vault / GCP Secret Manager

4. **Connection resiliency and pooling controls**
   - configurable pool size, timeouts, retries, statement timeout

5. **Operational endpoints**
   - health/readiness probes
   - metrics export (Prometheus/OpenTelemetry)

6. **Safer SQL policy engine**
   - denylist/allowlist per schema/table
   - per-tool max row limits and result truncation policy

7. **Query templating / parameterized named queries**
   - reduces risk from unrestricted ad-hoc SQL usage

8. **Multi-database routing**
   - per-request datasource selection with policy checks

9. **Schema drift intelligence**
   - detect schema changes, emit notifications, cache metadata

10. **Task/progress support for long-running operations**
    - enterprise UX for large queries and streaming progress

If you want, I can implement the next high-value step: **JWT/API-key auth for SSE mode + health endpoints + pool/statement timeout controls**.

---

## Development

```bash
npm run dev
npm run build
```