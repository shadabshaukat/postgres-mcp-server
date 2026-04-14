#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { URL } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

type JsonObject = Record<string, unknown>;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

type AccessMode = 'read-only' | 'read-write';
type TransportMode = 'stdio' | 'sse';

const VALID_ACCESS_MODES: AccessMode[] = ['read-only', 'read-write'];
const VALID_TRANSPORT_MODES: TransportMode[] = ['stdio', 'sse'];

const readCliArg = (name: string): string | undefined => {
  const exactIndex = process.argv.findIndex((arg) => arg === name);
  if (exactIndex >= 0 && process.argv[exactIndex + 1]) {
    return process.argv[exactIndex + 1];
  }

  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {
    return inline.split('=')[1];
  }

  return undefined;
};

const normalizeAccessMode = (value: string | undefined): AccessMode => {
  if (!value) {
    return 'read-only';
  }

  const normalized = value.toLowerCase().trim() as AccessMode;
  if (!VALID_ACCESS_MODES.includes(normalized)) {
    throw new Error(
      `Invalid MCP_DB_MODE: ${value}. Expected one of: ${VALID_ACCESS_MODES.join(', ')}`
    );
  }

  return normalized;
};

const readCliModeArg = (): string | undefined =>
  readCliArg('--db-mode') ?? readCliArg('--mode');

const normalizeTransportMode = (value: string | undefined): TransportMode => {
  if (!value) {
    return 'stdio';
  }

  const normalized = value.toLowerCase().trim() as TransportMode;
  if (!VALID_TRANSPORT_MODES.includes(normalized)) {
    throw new Error(
      `Invalid MCP_TRANSPORT: ${value}. Expected one of: ${VALID_TRANSPORT_MODES.join(', ')}`
    );
  }

  return normalized;
};

const toIntWithBounds = (value: unknown, fallback = DEFAULT_LIMIT): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const intVal = Math.floor(value);
  if (intVal < 1) {
    return 1;
  }

  return Math.min(intVal, MAX_LIMIT);
};

const isValidIdentifier = (identifier: string): boolean =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier);

const parseBoolean = (raw: string | undefined, fallback: boolean): boolean => {
  if (!raw) {
    return fallback;
  }

  const normalized = raw.toLowerCase().trim();
  if (['1', 'true', 'yes', 'y'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n'].includes(normalized)) {
    return false;
  }

  return fallback;
};

const maybeReadFile = (pathOrInline: string | undefined): string | undefined => {
  if (!pathOrInline) {
    return undefined;
  }

  if (fs.existsSync(pathOrInline)) {
    return fs.readFileSync(pathOrInline, 'utf8');
  }

  return pathOrInline.replace(/\\n/g, '\n');
};

const normalizeConnectionStringCredentials = (
  connectionString: string | undefined
): string | undefined => {
  if (!connectionString) {
    return connectionString;
  }

  const m = connectionString.match(/^(postgres(?:ql)?:\/\/)([^@/]+)@(.*)$/i);
  if (!m) {
    return connectionString;
  }

  const [, prefix, rawCreds, tail] = m;
  const colonIdx = rawCreds.indexOf(':');

  const normalizePart = (part: string): string => {
    try {
      return encodeURIComponent(decodeURIComponent(part));
    } catch {
      return encodeURIComponent(part);
    }
  };

  if (colonIdx === -1) {
    const user = normalizePart(rawCreds);
    return `${prefix}${user}@${tail}`;
  }

  const userRaw = rawCreds.slice(0, colonIdx);
  const passRaw = rawCreds.slice(colonIdx + 1);
  const user = normalizePart(userRaw);
  const pass = normalizePart(passRaw);
  return `${prefix}${user}:${pass}@${tail}`;
};

const validateAndWarnConnectionString = (connectionString: string | undefined) => {
  if (!connectionString) {
    return;
  }

  if (connectionString.includes('#')) {
    console.error(
      '[Startup Notice] Detected special characters in POSTGRES_URL/DATABASE_URL credentials. They will be URL-encoded automatically.'
    );
  }

  try {
    const parsed = new URL(connectionString);
    if (['localhost', '127.0.0.1'].includes(parsed.hostname)) {
      console.error(
        '[Startup Warning] Connection host is localhost/127.0.0.1. If running in Docker, this points to the container itself. Use host.docker.internal (macOS/Windows) or your host bridge/IP.'
      );
    }
  } catch {
    // ignore parse errors here; pg can still parse some DSN styles
  }
};

const maskConnectionStringPassword = (connectionString: string | undefined): string | undefined => {
  if (!connectionString) {
    return undefined;
  }

  try {
    const parsed = new URL(connectionString);
    if (parsed.password) {
      parsed.password = '******';
    }
    return parsed.toString();
  } catch {
    return connectionString.replace(
      /(postgres(?:ql)?:\/\/[^:\s@]+:)([^@\s]+)(@)/i,
      '$1******$3'
    );
  }
};

const buildSslConfig = (): pg.PoolConfig['ssl'] => {
  const sslMode = process.env.PGSSLMODE?.toLowerCase();

  const shouldEnableSsl =
    sslMode !== undefined &&
    ['require', 'verify-ca', 'verify-full', 'prefer', 'allow'].includes(sslMode);

  if (!shouldEnableSsl) {
    return undefined;
  }

  const strictDefault = sslMode === 'verify-ca' || sslMode === 'verify-full';
  const rejectUnauthorized = parseBoolean(process.env.PGSSLREJECTUNAUTHORIZED, strictDefault);

  const ca = maybeReadFile(process.env.PGSSLROOTCERT_PATH ?? process.env.PGSSLROOTCERT);
  const cert = maybeReadFile(process.env.PGSSLCERT_PATH ?? process.env.PGSSLCERT);
  const key = maybeReadFile(process.env.PGSSLKEY_PATH ?? process.env.PGSSLKEY);

  if (!ca && !cert && !key) {
    return { rejectUnauthorized };
  }

  return {
    rejectUnauthorized,
    ca,
    cert,
    key,
  };
};

const stripLeadingComments = (sql: string): string => {
  let s = sql.trimStart();

  while (true) {
    if (s.startsWith('--')) {
      const nextLine = s.indexOf('\n');
      s = nextLine === -1 ? '' : s.slice(nextLine + 1).trimStart();
      continue;
    }

    if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      s = end === -1 ? '' : s.slice(end + 2).trimStart();
      continue;
    }

    break;
  }

  return s;
};

const getMainKeywordAfterWith = (sql: string): string => {
  let depth = 0;
  let i = 0;
  const lower = sql.toLowerCase();

  while (i < lower.length) {
    const ch = lower[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);

    if (depth === 0) {
      const tail = lower.slice(i);
      const m = tail.match(/\b(select|insert|update|delete)\b/);
      if (m?.[1]) {
        return m[1];
      }
    }
    i += 1;
  }

  return 'unknown';
};

const detectStatementType = (sql: string): string => {
  const normalized = stripLeadingComments(sql).replace(/;+\s*$/, '').trim();
  if (!normalized) {
    return 'unknown';
  }

  const first = normalized.match(/^([a-zA-Z]+)/)?.[1]?.toLowerCase() ?? 'unknown';
  if (['select', 'insert', 'update', 'delete'].includes(first)) {
    return first;
  }

  if (first === 'with') {
    return getMainKeywordAfterWith(normalized.slice(4));
  }

  return first;
};

const enforceQueryMode = (sql: string, mode: AccessMode) => {
  const withoutTrailingSemicolon = sql.trim().replace(/;+\s*$/, '');
  if (withoutTrailingSemicolon.includes(';')) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Only a single SQL statement is allowed per request.'
    );
  }

  const statementType = detectStatementType(sql);

  if (mode === 'read-only') {
    if (statementType !== 'select') {
      throw new McpError(
        ErrorCode.InvalidParams,
        `read-only mode allows only SELECT statements. Received: ${statementType}`
      );
    }
    return statementType;
  }

  const allowedInReadWrite = ['select', 'insert', 'update', 'delete'];
  if (!allowedInReadWrite.includes(statementType)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `read-write mode allows SELECT/INSERT/UPDATE/DELETE only. Received: ${statementType}`
    );
  }

  return statementType;
};

const parseQualifiedName = (
  raw: string,
  defaultSchema = 'public'
): { schema: string; name: string } => {
  const parts = raw.split('.');

  if (parts.length === 1) {
    const name = parts[0];
    if (!isValidIdentifier(name)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid identifier: ${raw}. Use letters, numbers, and underscores only.`
      );
    }
    return { schema: defaultSchema, name };
  }

  if (parts.length === 2) {
    const [schema, name] = parts;
    if (!isValidIdentifier(schema) || !isValidIdentifier(name)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid qualified identifier: ${raw}. Use schema.object with safe identifiers.`
      );
    }
    return { schema, name };
  }

  throw new McpError(
    ErrorCode.InvalidParams,
    `Invalid name format: ${raw}. Expected table or schema.table.`
  );
};

const quoteIdent = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

class PostgresMcpServer {
  private readonly server: Server;
  private readonly pool: pg.Pool;
  private readonly accessMode: AccessMode;
  private readonly transportMode: TransportMode;
  private readonly sseHost: string;
  private readonly ssePort: number;
  private readonly ssePath: string;
  private readonly dbConnectionString?: string;
  private httpServer?: http.Server;
  private httpTransport?: StreamableHTTPServerTransport;

  constructor() {
    this.accessMode = normalizeAccessMode(readCliModeArg() ?? process.env.MCP_DB_MODE);
    this.transportMode = normalizeTransportMode(readCliArg('--transport') ?? process.env.MCP_TRANSPORT);
    this.sseHost = process.env.MCP_HTTP_HOST ?? '0.0.0.0';
    this.ssePort = Number(process.env.MCP_HTTP_PORT ?? '8080');
    this.ssePath = process.env.MCP_HTTP_PATH ?? '/mcp';
    this.dbConnectionString = normalizeConnectionStringCredentials(
      process.env.POSTGRES_URL ?? process.env.DATABASE_URL
    );

    validateAndWarnConnectionString(this.dbConnectionString);

    this.server = new Server(
      {
        name: 'postgres-mcp-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.pool = new Pool({
      connectionString: this.dbConnectionString,
      host: process.env.PGHOST,
      port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      ssl: buildSslConfig(),
    });

    this.setupHandlers();

    this.server.onerror = (error: unknown) => {
      console.error('[MCP Server Error]', error);
    };

    process.on('SIGINT', async () => {
      await this.shutdown();
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      await this.shutdown();
      process.exit(0);
    });
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'server_info',
          description: 'Show connection mode and server runtime information.',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: 'list_user_tables',
          description: 'List user tables (non-system schemas).',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: 'query_user_table',
          description:
            'Query rows from a user table. Provide table as "table" or "schema.table". Rows are limited for safety.',
          inputSchema: {
            type: 'object',
            properties: {
              table: {
                type: 'string',
                description: 'User table name in table or schema.table format.',
              },
              limit: {
                type: 'number',
                minimum: 1,
                maximum: MAX_LIMIT,
                description: `Maximum rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
              },
            },
            required: ['table'],
            additionalProperties: false,
          },
        },
        {
          name: 'list_schemas',
          description:
            'List schemas in the current database. By default excludes pg_catalog and information_schema.',
          inputSchema: {
            type: 'object',
            properties: {
              includeSystem: {
                type: 'boolean',
                description: 'Include pg_catalog and information_schema when true.',
              },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'describe_relation',
          description:
            'Describe columns for a relation (table/view/materialized view/foreign table/partitioned table).',
          inputSchema: {
            type: 'object',
            properties: {
              relation: {
                type: 'string',
                description: 'Relation name in relation or schema.relation format.',
              },
            },
            required: ['relation'],
            additionalProperties: false,
          },
        },
        {
          name: 'execute_sql',
          description:
            'Execute SQL with access mode enforcement. read-only allows SELECT only; read-write allows SELECT/INSERT/UPDATE/DELETE.',
          inputSchema: {
            type: 'object',
            properties: {
              sql: {
                type: 'string',
                description: 'Single SQL statement to execute.',
              },
            },
            required: ['sql'],
            additionalProperties: false,
          },
        },
        {
          name: 'list_extensions',
          description: 'List installed PostgreSQL extensions in the current database.',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: 'list_system_catalogs',
          description: 'List PostgreSQL catalog relations in pg_catalog.',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: 'query_system_catalog',
          description:
            'Query rows from a pg_catalog table/view (e.g., pg_class, pg_database, pg_roles).',
          inputSchema: {
            type: 'object',
            properties: {
              catalog: {
                type: 'string',
                description: 'Catalog object name inside pg_catalog (e.g., pg_class).',
              },
              limit: {
                type: 'number',
                minimum: 1,
                maximum: MAX_LIMIT,
                description: `Maximum rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
              },
            },
            required: ['catalog'],
            additionalProperties: false,
          },
        },
        {
          name: 'list_views',
          description: 'List views. By default excludes pg_catalog and information_schema.',
          inputSchema: {
            type: 'object',
            properties: {
              includeSystem: {
                type: 'boolean',
                description: 'Include system schemas when true.',
              },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'query_view',
          description:
            'Query rows from a view. Provide view as "view" or "schema.view". Rows are limited for safety.',
          inputSchema: {
            type: 'object',
            properties: {
              view: {
                type: 'string',
                description: 'View name in view or schema.view format.',
              },
              limit: {
                type: 'number',
                minimum: 1,
                maximum: MAX_LIMIT,
                description: `Maximum rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
              },
            },
            required: ['view'],
            additionalProperties: false,
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
      try {
        switch (request.params.name) {
          case 'server_info':
            return this.asToolResult(await this.serverInfo());
          case 'list_user_tables':
            return this.asToolResult(await this.listUserTables());
          case 'list_schemas':
            return this.asToolResult(await this.listSchemas(request.params.arguments));
          case 'describe_relation':
            return this.asToolResult(await this.describeRelation(request.params.arguments));
          case 'execute_sql':
            return this.asToolResult(await this.executeSql(request.params.arguments));
          case 'list_extensions':
            return this.asToolResult(await this.listExtensions());
          case 'query_user_table':
            return this.asToolResult(await this.queryUserTable(request.params.arguments));
          case 'list_system_catalogs':
            return this.asToolResult(await this.listSystemCatalogs());
          case 'query_system_catalog':
            return this.asToolResult(await this.querySystemCatalog(request.params.arguments));
          case 'list_views':
            return this.asToolResult(await this.listViews(request.params.arguments));
          case 'query_view':
            return this.asToolResult(await this.queryView(request.params.arguments));
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }

        const message = error instanceof Error ? error.message : 'Unknown error';
        return {
          content: [{ type: 'text', text: `Database operation failed: ${message}` }],
          isError: true,
        };
      }
    });
  }

  private async serverInfo() {
    const dbInfo = await this.pool.query(`
      SELECT
        current_database() AS database,
        current_user AS current_user,
        version() AS version,
        inet_server_addr()::text AS server_address,
        inet_server_port() AS server_port;
    `);

    return {
      name: 'postgres-mcp-server',
      accessMode: this.accessMode,
      transportMode: this.transportMode,
      endpoint:
        this.transportMode === 'sse'
          ? `http://${this.sseHost}:${this.ssePort}${this.ssePath}`
          : null,
      sslMode: process.env.PGSSLMODE ?? 'disable/not-set',
      data: dbInfo.rows[0],
    };
  }

  private async parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) {
      return {};
    }

    try {
      return JSON.parse(raw);
    } catch {
      throw new McpError(ErrorCode.InvalidRequest, 'Request body must be valid JSON.');
    }
  }

  private sendHttpError(
    res: http.ServerResponse,
    code: number,
    message: string,
    details?: unknown
  ) {
    if (res.writableEnded) {
      return;
    }

    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        {
          error: message,
          details,
        },
        null,
        2
      )
    );
  }

  private async handleStreamableHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== this.ssePath) {
      this.sendHttpError(res, 404, `Not found. Use endpoint: ${this.ssePath}`);
      return;
    }

    const method = (req.method ?? 'GET').toUpperCase();

    if (method === 'POST') {
      const parsedBody = await this.parseJsonBody(req);
      await this.httpTransport!.handleRequest(req, res, parsedBody);
      return;
    }

    if (method === 'GET' || method === 'DELETE') {
      await this.httpTransport!.handleRequest(req, res);
      return;
    }

    this.sendHttpError(res, 405, 'Method Not Allowed. Use GET, POST, or DELETE.');
  }

  private async runSseHttp() {
    this.httpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await this.server.connect(this.httpTransport);

    this.httpServer = http.createServer(async (req, res) => {
      try {
        await this.handleStreamableHttpRequest(req, res);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown server error';
        console.error(
          `[MCP HTTP Error] ${req.method ?? 'UNKNOWN'} ${req.url ?? '/'} -> ${message}`,
          error
        );
        this.sendHttpError(res, 500, message);
      }
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.httpServer!;
      server.once('error', reject);
      server.listen(this.ssePort, this.sseHost, () => {
        server.off('error', reject);
        resolve();
      });
    });

    console.error(
      `Postgres MCP server running on Streamable HTTP (${this.accessMode} mode) at http://${this.sseHost}:${this.ssePort}${this.ssePath}`
    );
  }

  private async listSchemas(args: unknown) {
    const includeSystem =
      !!args && typeof args === 'object' && (args as JsonObject).includeSystem === true;

    const sql = includeSystem
      ? `
        SELECT schema_name
        FROM information_schema.schemata
        ORDER BY schema_name;
      `
      : `
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
          AND schema_name NOT LIKE 'pg_toast%'
          AND schema_name NOT LIKE 'pg_temp%'
        ORDER BY schema_name;
      `;

    const result = await this.pool.query(sql);
    return {
      includeSystem,
      count: result.rowCount,
      schemas: result.rows,
    };
  }

  private async describeRelation(args: unknown) {
    if (!args || typeof args !== 'object') {
      throw new McpError(ErrorCode.InvalidParams, 'Arguments are required.');
    }

    const { relation } = args as JsonObject;
    if (typeof relation !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'relation must be a string.');
    }

    const parsed = parseQualifiedName(relation, 'public');

    const kindSql = `
      SELECT c.relkind
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2
      LIMIT 1;
    `;
    const kindResult = await this.pool.query<{ relkind: string }>(kindSql, [
      parsed.schema,
      parsed.name,
    ]);

    if (!kindResult.rows[0]) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Relation not found: ${parsed.schema}.${parsed.name}`
      );
    }

    const typeMap: Record<string, string> = {
      r: 'table',
      v: 'view',
      m: 'materialized_view',
      f: 'foreign_table',
      p: 'partitioned_table',
    };

    const columnsSql = `
      SELECT
        ordinal_position,
        column_name,
        data_type,
        udt_name,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position;
    `;

    const columnsResult = await this.pool.query(columnsSql, [parsed.schema, parsed.name]);

    return {
      relation: `${parsed.schema}.${parsed.name}`,
      relationType: typeMap[kindResult.rows[0].relkind] ?? 'unknown',
      columnCount: columnsResult.rowCount,
      columns: columnsResult.rows,
    };
  }

  private asToolResult(payload: unknown) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  private async listUserTables() {
    const sql = `
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name;
    `;
    const result = await this.pool.query(sql);
    return {
      count: result.rowCount,
      tables: result.rows,
    };
  }

  private async queryUserTable(args: unknown) {
    if (!args || typeof args !== 'object') {
      throw new McpError(ErrorCode.InvalidParams, 'Arguments are required.');
    }

    const { table, limit } = args as JsonObject;
    if (typeof table !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'table must be a string.');
    }

    const parsed = parseQualifiedName(table, 'public');
    if (parsed.schema === 'pg_catalog' || parsed.schema === 'information_schema') {
      throw new McpError(
        ErrorCode.InvalidParams,
        'query_user_table only allows non-system schemas.'
      );
    }

    const rowLimit = toIntWithBounds(limit);
    const sql = `SELECT * FROM ${quoteIdent(parsed.schema)}.${quoteIdent(parsed.name)} LIMIT $1;`;
    const result = await this.pool.query(sql, [rowLimit]);

    return {
      table: `${parsed.schema}.${parsed.name}`,
      limit: rowLimit,
      rowCount: result.rowCount,
      rows: result.rows,
    };
  }

  private async executeSql(args: unknown) {
    if (!args || typeof args !== 'object') {
      throw new McpError(ErrorCode.InvalidParams, 'Arguments are required.');
    }

    const { sql } = args as JsonObject;
    if (typeof sql !== 'string' || sql.trim().length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'sql must be a non-empty string.');
    }

    const statementType = enforceQueryMode(sql, this.accessMode);
    const result = await this.pool.query(sql);

    return {
      accessMode: this.accessMode,
      statementType,
      rowCount: result.rowCount,
      command: result.command,
      rows: result.rows,
    };
  }

  private async listExtensions() {
    const sql = `
      SELECT
        e.extname AS extension_name,
        e.extversion AS extension_version,
        n.nspname AS extension_schema
      FROM pg_catalog.pg_extension e
      JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
      ORDER BY e.extname;
    `;
    const result = await this.pool.query(sql);
    return {
      count: result.rowCount,
      extensions: result.rows,
    };
  }

  private async listSystemCatalogs() {
    const sql = `
      SELECT schemaname, viewname AS relation_name, 'view' AS relation_type
      FROM pg_catalog.pg_views
      WHERE schemaname = 'pg_catalog'
      UNION ALL
      SELECT schemaname, tablename AS relation_name, 'table' AS relation_type
      FROM pg_catalog.pg_tables
      WHERE schemaname = 'pg_catalog'
      ORDER BY relation_type, relation_name;
    `;
    const result = await this.pool.query(sql);
    return {
      count: result.rowCount,
      catalogs: result.rows,
    };
  }

  private async querySystemCatalog(args: unknown) {
    if (!args || typeof args !== 'object') {
      throw new McpError(ErrorCode.InvalidParams, 'Arguments are required.');
    }

    const { catalog, limit } = args as JsonObject;
    if (typeof catalog !== 'string' || !isValidIdentifier(catalog)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'catalog must be a valid identifier such as pg_class.'
      );
    }

    const existsSql = `
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pg_catalog'
          AND c.relname = $1
          AND c.relkind IN ('r', 'v', 'm', 'f', 'p')
      ) AS exists;
    `;
    const existsResult = await this.pool.query<{ exists: boolean }>(existsSql, [catalog]);
    if (!existsResult.rows[0]?.exists) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Catalog object not found in pg_catalog: ${catalog}`
      );
    }

    const rowLimit = toIntWithBounds(limit);
    const sql = `SELECT * FROM pg_catalog.${quoteIdent(catalog)} LIMIT $1;`;
    const result = await this.pool.query(sql, [rowLimit]);

    return {
      catalog: `pg_catalog.${catalog}`,
      limit: rowLimit,
      rowCount: result.rowCount,
      rows: result.rows,
    };
  }

  private async listViews(args: unknown) {
    const includeSystem =
      !!args && typeof args === 'object' && (args as JsonObject).includeSystem === true;

    const sql = includeSystem
      ? `
        SELECT schemaname, viewname
        FROM pg_catalog.pg_views
        ORDER BY schemaname, viewname;
      `
      : `
        SELECT schemaname, viewname
        FROM pg_catalog.pg_views
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY schemaname, viewname;
      `;

    const result = await this.pool.query(sql);
    return {
      includeSystem,
      count: result.rowCount,
      views: result.rows,
    };
  }

  private async queryView(args: unknown) {
    if (!args || typeof args !== 'object') {
      throw new McpError(ErrorCode.InvalidParams, 'Arguments are required.');
    }

    const { view, limit } = args as JsonObject;
    if (typeof view !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'view must be a string.');
    }

    const parsed = parseQualifiedName(view, 'public');
    const rowLimit = toIntWithBounds(limit);

    const existsSql = `
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_views
        WHERE schemaname = $1 AND viewname = $2
      ) AS exists;
    `;

    const exists = await this.pool.query<{ exists: boolean }>(existsSql, [
      parsed.schema,
      parsed.name,
    ]);

    if (!exists.rows[0]?.exists) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `View not found: ${parsed.schema}.${parsed.name}`
      );
    }

    const sql = `SELECT * FROM ${quoteIdent(parsed.schema)}.${quoteIdent(parsed.name)} LIMIT $1;`;
    const result = await this.pool.query(sql, [rowLimit]);

    return {
      view: `${parsed.schema}.${parsed.name}`,
      limit: rowLimit,
      rowCount: result.rowCount,
      rows: result.rows,
    };
  }

  private async shutdown() {
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer?.close(() => resolve());
      });
      this.httpServer = undefined;
    }

    if (this.httpTransport) {
      await this.httpTransport.close();
      this.httpTransport = undefined;
    }

    await this.pool.end();
    await this.server.close();
  }

  private async verifyDatabaseConnection() {
    const result = await this.pool.query<{
      database: string;
      current_user: string;
      server_address: string | null;
      server_port: number | null;
    }>(`
      SELECT
        current_database() AS database,
        current_user AS current_user,
        inet_server_addr()::text AS server_address,
        inet_server_port() AS server_port;
    `);

    const row = result.rows[0];
    const maskedConn = maskConnectionStringPassword(this.dbConnectionString);
    const maskedPgPassword = process.env.PGPASSWORD ? '******' : '(not set)';

    console.error(
      [
        'Database connected successfully',
        `db=${row.database}`,
        `user=${row.current_user}`,
        `host=${row.server_address ?? 'n/a'}`,
        `port=${row.server_port ?? 'n/a'}`,
        `mode=${this.accessMode}`,
        `transport=${this.transportMode}`,
        maskedConn ? `connectionString=${maskedConn}` : 'connectionString=(not set)',
        `PGHOST=${process.env.PGHOST ?? '(not set)'}`,
        `PGPORT=${process.env.PGPORT ?? '(not set)'}`,
        `PGDATABASE=${process.env.PGDATABASE ?? '(not set)'}`,
        `PGUSER=${process.env.PGUSER ?? '(not set)'}`,
        `PGPASSWORD=${maskedPgPassword}`,
      ].join(' | ')
    );
  }

  async run() {
    await this.verifyDatabaseConnection();

    if (this.transportMode === 'sse') {
      await this.runSseHttp();
      return;
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`Postgres MCP server running on stdio (${this.accessMode} mode)`);
  }
}

const server = new PostgresMcpServer();

server.run().catch((error) => {
  console.error('Fatal error running Postgres MCP server:', error);
  process.exit(1);
});