#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type TextContent,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { URL } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

type JsonObject = Record<string, unknown>;
type AccessMode = 'restricted' | 'unrestricted';
type TransportMode = 'stdio' | 'sse';

const VALID_ACCESS_MODES: AccessMode[] = ['restricted', 'unrestricted'];
const VALID_TRANSPORT_MODES: TransportMode[] = ['stdio', 'sse'];

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 5000;

const readCliArg = (name: string): string | undefined => {
  const exactIndex = process.argv.findIndex((arg) => arg === name);
  if (exactIndex >= 0 && process.argv[exactIndex + 1]) {
    return process.argv[exactIndex + 1];
  }

  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1);
  }

  return undefined;
};

const readBool = (raw: string | undefined, fallback: boolean): boolean => {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const normalizeAccessMode = (raw: string | undefined): AccessMode => {
  const normalized = (raw ?? 'restricted').trim().toLowerCase() as AccessMode;
  if (!VALID_ACCESS_MODES.includes(normalized)) {
    throw new Error(`Invalid access mode: ${raw}. Expected: ${VALID_ACCESS_MODES.join(', ')}`);
  }
  return normalized;
};

const normalizeTransportMode = (raw: string | undefined): TransportMode => {
  const normalized = (raw ?? 'stdio').trim().toLowerCase() as TransportMode;
  if (!VALID_TRANSPORT_MODES.includes(normalized)) {
    throw new Error(`Invalid transport mode: ${raw}. Expected: ${VALID_TRANSPORT_MODES.join(', ')}`);
  }
  return normalized;
};

const toBoundedLimit = (value: unknown, fallback = DEFAULT_LIMIT): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  if (n < 1) return 1;
  return Math.min(n, MAX_LIMIT);
};

const isIdentifier = (s: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
const quoteIdent = (s: string): string => `"${s.replace(/"/g, '""')}"`;

const parseName = (
  raw: string,
  defaultSchema = 'public'
): { schema: string; name: string } => {
  const parts = raw.split('.');
  if (parts.length === 1) {
    const name = parts[0];
    if (!isIdentifier(name)) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid identifier: ${raw}`);
    }
    return { schema: defaultSchema, name };
  }

  if (parts.length === 2) {
    const [schema, name] = parts;
    if (!isIdentifier(schema) || !isIdentifier(name)) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid qualified identifier: ${raw}`);
    }
    return { schema, name };
  }

  throw new McpError(ErrorCode.InvalidParams, `Invalid name format: ${raw}`);
};

const maybeReadFile = (pathOrInline: string | undefined): string | undefined => {
  if (!pathOrInline) return undefined;
  if (fs.existsSync(pathOrInline)) {
    return fs.readFileSync(pathOrInline, 'utf8');
  }
  return pathOrInline.replace(/\\n/g, '\n');
};

const buildSslConfig = (): pg.PoolConfig['ssl'] => {
  const sslMode = process.env.PGSSLMODE?.toLowerCase();
  const enableSsl =
    sslMode !== undefined &&
    ['require', 'verify-ca', 'verify-full', 'prefer', 'allow'].includes(sslMode);

  if (!enableSsl) return undefined;

  const strictDefault = sslMode === 'verify-ca' || sslMode === 'verify-full';
  const rejectUnauthorized = readBool(process.env.PGSSLREJECTUNAUTHORIZED, strictDefault);

  const ca = maybeReadFile(process.env.PGSSLROOTCERT_PATH ?? process.env.PGSSLROOTCERT);
  const cert = maybeReadFile(process.env.PGSSLCERT_PATH ?? process.env.PGSSLCERT);
  const key = maybeReadFile(process.env.PGSSLKEY_PATH ?? process.env.PGSSLKEY);

  return {
    rejectUnauthorized,
    ca,
    cert,
    key,
  };
};

const normalizeConnectionUriCredentials = (uri: string | undefined): string | undefined => {
  if (!uri) return uri;

  const m = uri.match(/^(postgres(?:ql)?:\/\/)([^@/]+)@(.*)$/i);
  if (!m) return uri;

  const [, prefix, rawCreds, tail] = m;
  const idx = rawCreds.indexOf(':');

  const normalizePart = (part: string): string => {
    try {
      return encodeURIComponent(decodeURIComponent(part));
    } catch {
      return encodeURIComponent(part);
    }
  };

  if (idx === -1) {
    return `${prefix}${normalizePart(rawCreds)}@${tail}`;
  }

  const user = normalizePart(rawCreds.slice(0, idx));
  const password = normalizePart(rawCreds.slice(idx + 1));
  return `${prefix}${user}:${password}@${tail}`;
};

const remapLocalhostInDocker = (uri: string | undefined): string | undefined => {
  if (!uri) return uri;
  if (!fs.existsSync('/.dockerenv')) return uri;

  try {
    const parsed = new URL(uri);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      parsed.hostname = process.env.MCP_DOCKER_HOST_ALIAS ?? 'host.docker.internal';
      return parsed.toString();
    }
    return uri;
  } catch {
    return uri;
  }
};

const maskConnectionUriPassword = (uri: string | undefined): string | undefined => {
  if (!uri) return undefined;

  try {
    const parsed = new URL(uri);
    if (parsed.password) parsed.password = '******';
    return parsed.toString();
  } catch {
    return uri.replace(/(postgres(?:ql)?:\/\/[^:\s@]+:)([^@\s]+)(@)/i, '$1******$3');
  }
};

const setConnectionUriSslMode = (
  uri: string | undefined,
  mode: 'disable' | 'require' | 'verify-full'
): string | undefined => {
  if (!uri) return uri;
  try {
    const parsed = new URL(uri);
    parsed.searchParams.set('sslmode', mode);
    return parsed.toString();
  } catch {
    return uri;
  }
};

const stripComments = (sql: string): string => {
  let s = sql.trimStart();

  while (true) {
    if (s.startsWith('--')) {
      const i = s.indexOf('\n');
      s = i === -1 ? '' : s.slice(i + 1).trimStart();
      continue;
    }
    if (s.startsWith('/*')) {
      const i = s.indexOf('*/');
      s = i === -1 ? '' : s.slice(i + 2).trimStart();
      continue;
    }
    break;
  }

  return s;
};

const detectStatementType = (sql: string): string => {
  const normalized = stripComments(sql).replace(/;+\s*$/, '').trim();
  if (!normalized) return 'unknown';
  const first = normalized.match(/^([a-zA-Z]+)/)?.[1]?.toLowerCase() ?? 'unknown';
  if (first === 'with') {
    return /\b(select|insert|update|delete)\b/i.exec(normalized)?.[1].toLowerCase() ?? 'with';
  }
  return first;
};

const assertRestrictedSqlSafe = (sql: string): string => {
  const cleaned = sql.trim().replace(/;+\s*$/, '');
  if (!cleaned) {
    throw new McpError(ErrorCode.InvalidParams, 'SQL must be non-empty.');
  }

  if (cleaned.includes(';')) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Restricted mode allows only a single SQL statement per request.'
    );
  }

  const stmt = detectStatementType(cleaned);
  const allowed = new Set(['select', 'with', 'show', 'explain']);
  if (!allowed.has(stmt)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Restricted mode permits SELECT/WITH/SHOW/EXPLAIN only. Received: ${stmt}`
    );
  }

  const lowered = cleaned.toLowerCase();
  const forbidden = ['commit', 'rollback', 'begin', 'start transaction', 'copy ', 'alter ', 'drop ', 'create '];
  if (forbidden.some((k) => lowered.includes(k))) {
    throw new McpError(ErrorCode.InvalidParams, 'Restricted mode rejected unsafe SQL keywords.');
  }

  return stmt;
};

class DbConnPool {
  private connectionString: string | undefined;
  private pool: pg.Pool;
  private sslConfig: pg.PoolConfig['ssl'];

  constructor(connectionString: string | undefined) {
    this.connectionString = connectionString;
    this.sslConfig = buildSslConfig();
    this.pool = new Pool({
      connectionString: this.connectionString,
      host: process.env.PGHOST,
      port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      ssl: this.sslConfig,
      max: Number(process.env.PGPOOL_MAX ?? '10'),
      idleTimeoutMillis: Number(process.env.PGPOOL_IDLE_TIMEOUT_MS ?? '30000'),
      connectionTimeoutMillis: Number(process.env.PGPOOL_CONNECTION_TIMEOUT_MS ?? '10000'),
    });
  }

  private async rebuildPool(
    nextConnectionString: string | undefined,
    nextSslConfig: pg.PoolConfig['ssl']
  ): Promise<void> {
    await this.pool.end();
    this.connectionString = nextConnectionString;
    this.sslConfig = nextSslConfig;
    this.pool = new Pool({
      connectionString: this.connectionString,
      host: process.env.PGHOST,
      port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      ssl: this.sslConfig,
      max: Number(process.env.PGPOOL_MAX ?? '10'),
      idleTimeoutMillis: Number(process.env.PGPOOL_IDLE_TIMEOUT_MS ?? '30000'),
      connectionTimeoutMillis: Number(process.env.PGPOOL_CONNECTION_TIMEOUT_MS ?? '10000'),
    });
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: any[]
  ): Promise<pg.QueryResult<T>> {
    return this.pool.query<T>(sql, params);
  }

  async testConnection(): Promise<{
    database: string;
    current_user: string;
    server_address: string | null;
    server_port: number | null;
  }> {
    try {
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

      return result.rows[0];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const allowFallback = readBool(process.env.MCP_SSL_FALLBACK_TO_DISABLE, true);

      if (allowFallback && /does not support ssl connections/i.test(message)) {
        const nextConnectionString = setConnectionUriSslMode(this.connectionString, 'disable');
        console.error(
          '[Startup Notice] Database rejected SSL. Retrying once with sslmode=disable (set MCP_SSL_FALLBACK_TO_DISABLE=false to disable this behavior).'
        );
        await this.rebuildPool(nextConnectionString, undefined);

        const retry = await this.pool.query<{
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
        return retry.rows[0];
      }

      throw error;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PostgresMcpServer {
  private readonly server: Server;
  private readonly db: DbConnPool;
  private readonly accessMode: AccessMode;
  private readonly transportMode: TransportMode;
  private readonly sseHost: string;
  private readonly ssePort: number;
  private readonly ssePath: string;
  private readonly legacySsePath: string;
  private readonly legacyMessagesPath: string;
  private readonly databaseUri?: string;
  private httpServer?: http.Server;
  private httpTransport?: StreamableHTTPServerTransport;
  private readonly legacySessions = new Map<
    string,
    {
      transport: SSEServerTransport;
      server: Server;
    }
  >();

  constructor() {
    this.accessMode = normalizeAccessMode(
      readCliArg('--access-mode') ?? readCliArg('--db-mode') ?? process.env.MCP_DB_MODE
    );
    this.transportMode = normalizeTransportMode(
      readCliArg('--transport') ?? process.env.MCP_TRANSPORT
    );

    this.sseHost = process.env.MCP_HTTP_HOST ?? '0.0.0.0';
    this.ssePort = Number(process.env.MCP_HTTP_PORT ?? '8899');
    this.ssePath = process.env.MCP_HTTP_PATH ?? '/mcp';
    this.legacySsePath = process.env.MCP_LEGACY_SSE_PATH ?? '/sse';
    this.legacyMessagesPath = process.env.MCP_LEGACY_MESSAGES_PATH ?? '/messages';

    const rawUri =
      process.env.DATABASE_URI ?? process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
    const normalizedUri = normalizeConnectionUriCredentials(rawUri);
    this.databaseUri = readBool(process.env.MCP_AUTO_REMAP_LOCALHOST, true)
      ? remapLocalhostInDocker(normalizedUri)
      : normalizedUri;

    this.server = new Server(
      {
        name: 'postgres-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: { tools: {} },
      }
    );

    this.db = new DbConnPool(this.databaseUri);
    this.setupToolHandlers(this.server);

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

  private createSessionServer(): Server {
    return new Server(
      {
        name: 'postgres-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: { tools: {} },
      }
    );
  }

  private setupToolHandlers(target: Server) {
    target.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'server_info',
          description: 'Shows runtime config and DB connection metadata.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        {
          name: 'list_schemas',
          description: 'List all schemas, optionally including system schemas.',
          inputSchema: {
            type: 'object',
            properties: {
              includeSystem: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'list_objects',
          description:
            'List objects in a schema. objectType can be table, view, sequence, extension.',
          inputSchema: {
            type: 'object',
            properties: {
              schema: { type: 'string' },
              objectType: { type: 'string', enum: ['table', 'view', 'sequence', 'extension'] },
            },
            required: ['schema', 'objectType'],
            additionalProperties: false,
          },
        },
        {
          name: 'get_object_details',
          description: 'Get detailed table/view/sequence metadata.',
          inputSchema: {
            type: 'object',
            properties: {
              schema: { type: 'string' },
              objectName: { type: 'string' },
              objectType: { type: 'string', enum: ['table', 'view', 'sequence'] },
            },
            required: ['schema', 'objectName', 'objectType'],
            additionalProperties: false,
          },
        },
        {
          name: 'list_extensions',
          description: 'List installed database extensions.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        {
          name: 'execute_sql',
          description:
            'Execute SQL with access mode enforcement. restricted mode allows read-only statements only.',
          inputSchema: {
            type: 'object',
            properties: {
              sql: { type: 'string' },
              limit: { type: 'number', minimum: 1, maximum: MAX_LIMIT },
            },
            required: ['sql'],
            additionalProperties: false,
          },
        },
      ],
    }));

    target.setRequestHandler(CallToolRequestSchema, async (request: any) => {
      try {
        const name = request.params.name;
        const args = request.params.arguments;

        switch (name) {
          case 'server_info':
            return this.asToolResult(await this.serverInfo());
          case 'list_schemas':
            return this.asToolResult(await this.listSchemas(args));
          case 'list_objects':
            return this.asToolResult(await this.listObjects(args));
          case 'get_object_details':
            return this.asToolResult(await this.getObjectDetails(args));
          case 'list_extensions':
            return this.asToolResult(await this.listExtensions());
          case 'execute_sql':
            return this.asToolResult(await this.executeSql(args));
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error) {
        if (error instanceof McpError) throw error;
        const message = error instanceof Error ? error.message : 'Unknown error';
        return {
          isError: true,
          content: [{ type: 'text', text: `Database operation failed: ${message}` } satisfies TextContent],
        };
      }
    });
  }

  private asToolResult(payload: unknown) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    };
  }

  private async serverInfo() {
    const dbConn = await this.db.testConnection();

    return {
      server: {
        name: 'postgres-mcp-server',
        accessMode: this.accessMode,
        transportMode: this.transportMode,
        endpoint:
          this.transportMode === 'sse'
            ? `http://${this.sseHost}:${this.ssePort}${this.ssePath}`
            : null,
      },
      database: dbConn,
      sslMode: process.env.PGSSLMODE ?? 'disable/not-set',
    };
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

    const result = await this.db.query(sql);
    return { includeSystem, count: result.rowCount, schemas: result.rows };
  }

  private async listObjects(args: unknown) {
    if (!args || typeof args !== 'object') {
      throw new McpError(ErrorCode.InvalidParams, 'Arguments are required.');
    }

    const { schema, objectType } = args as JsonObject;
    if (typeof schema !== 'string' || !isIdentifier(schema)) {
      throw new McpError(ErrorCode.InvalidParams, 'schema must be a valid identifier string.');
    }
    if (
      typeof objectType !== 'string' ||
      !['table', 'view', 'sequence', 'extension'].includes(objectType)
    ) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "objectType must be one of: table, view, sequence, extension."
      );
    }

    if (objectType === 'extension') {
      const ext = await this.listExtensions();
      return {
        schema,
        objectType,
        count: ext.count,
        objects: ext.extensions,
      };
    }

    if (objectType === 'sequence') {
      const result = await this.db.query(
        `
        SELECT sequence_schema AS schema_name, sequence_name AS object_name, data_type
        FROM information_schema.sequences
        WHERE sequence_schema = $1
        ORDER BY sequence_name;
      `,
        [schema]
      );

      return { schema, objectType, count: result.rowCount, objects: result.rows };
    }

    const tableType = objectType === 'table' ? 'BASE TABLE' : 'VIEW';
    const result = await this.db.query(
      `
      SELECT table_schema AS schema_name, table_name AS object_name, table_type
      FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = $2
      ORDER BY table_name;
    `,
      [schema, tableType]
    );

    return { schema, objectType, count: result.rowCount, objects: result.rows };
  }

  private async getObjectDetails(args: unknown) {
    if (!args || typeof args !== 'object') {
      throw new McpError(ErrorCode.InvalidParams, 'Arguments are required.');
    }

    const { schema, objectName, objectType } = args as JsonObject;
    if (typeof schema !== 'string' || !isIdentifier(schema)) {
      throw new McpError(ErrorCode.InvalidParams, 'schema must be a valid identifier string.');
    }
    if (typeof objectName !== 'string' || !isIdentifier(objectName)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'objectName must be a valid identifier string.'
      );
    }
    if (typeof objectType !== 'string' || !['table', 'view', 'sequence'].includes(objectType)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "objectType must be one of: table, view, sequence."
      );
    }

    if (objectType === 'sequence') {
      const seq = await this.db.query(
        `
        SELECT sequence_schema, sequence_name, data_type, start_value, minimum_value, maximum_value, increment
        FROM information_schema.sequences
        WHERE sequence_schema = $1 AND sequence_name = $2;
      `,
        [schema, objectName]
      );
      return {
        basic: { schema, objectName, objectType },
        details: seq.rows[0] ?? null,
      };
    }

    const columns = await this.db.query(
      `
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
    `,
      [schema, objectName]
    );

    const constraints = await this.db.query(
      `
      SELECT tc.constraint_name, tc.constraint_type, kcu.column_name
      FROM information_schema.table_constraints AS tc
      LEFT JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = $1 AND tc.table_name = $2
      ORDER BY tc.constraint_name, kcu.ordinal_position;
    `,
      [schema, objectName]
    );

    const indexes = await this.db.query(
      `
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = $1 AND tablename = $2
      ORDER BY indexname;
    `,
      [schema, objectName]
    );

    return {
      basic: { schema, objectName, objectType },
      columns: columns.rows,
      constraints: constraints.rows,
      indexes: indexes.rows,
    };
  }

  private async listExtensions() {
    const result = await this.db.query(
      `
      SELECT
        e.extname AS extension_name,
        e.extversion AS extension_version,
        n.nspname AS extension_schema
      FROM pg_catalog.pg_extension e
      JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
      ORDER BY e.extname;
    `
    );

    return { count: result.rowCount, extensions: result.rows };
  }

  private async executeSql(args: unknown) {
    if (!args || typeof args !== 'object') {
      throw new McpError(ErrorCode.InvalidParams, 'Arguments are required.');
    }

    const { sql, limit } = args as JsonObject;
    if (typeof sql !== 'string' || sql.trim().length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'sql must be a non-empty string.');
    }

    const statementType =
      this.accessMode === 'restricted' ? assertRestrictedSqlSafe(sql) : detectStatementType(sql);

    const bounded = toBoundedLimit(limit, DEFAULT_LIMIT);
    const wrappedSql =
      this.accessMode === 'restricted' && ['select', 'with'].includes(statementType)
        ? `SELECT * FROM (${sql.trim().replace(/;+\s*$/, '')}) AS _mcp_subquery LIMIT ${bounded}`
        : sql;

    const result = await this.db.query(wrappedSql);
    return {
      accessMode: this.accessMode,
      statementType,
      rowCount: result.rowCount,
      command: result.command,
      limitApplied:
        this.accessMode === 'restricted' && ['select', 'with'].includes(statementType)
          ? bounded
          : null,
      rows: result.rows,
    };
  }

  private async parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return {};

    try {
      return JSON.parse(raw);
    } catch {
      throw new McpError(ErrorCode.InvalidRequest, 'Request body must be valid JSON.');
    }
  }

  private sendHttpError(res: http.ServerResponse, code: number, message: string, details?: unknown) {
    if (res.writableEnded || res.headersSent) return;
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: message, details }, null, 2));
  }

  private async handleStreamableHttpRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === this.legacySsePath || pathname === this.legacyMessagesPath) {
      await this.handleLegacySseRequest(req, res, url);
      return;
    }

    if (pathname !== this.ssePath) {
      this.sendHttpError(
        res,
        404,
        `Not found. Use endpoints: ${this.ssePath} (streamable), ${this.legacySsePath} (legacy SSE)`
      );
      return;
    }

    const method = (req.method ?? 'GET').toUpperCase();
    if (method === 'POST') {
      const body = await this.parseJsonBody(req);
      await this.httpTransport!.handleRequest(req, res, body);
      return;
    }
    if (method === 'GET' || method === 'DELETE') {
      await this.httpTransport!.handleRequest(req, res);
      return;
    }
    this.sendHttpError(res, 405, 'Method Not Allowed. Use GET, POST, or DELETE.');
  }

  private async handleLegacySseRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ) {
    const method = (req.method ?? 'GET').toUpperCase();

    if (url.pathname === this.legacySsePath) {
      if (method !== 'GET') {
        this.sendHttpError(res, 405, `Legacy SSE endpoint supports GET only: ${this.legacySsePath}`);
        return;
      }

      const transport = new SSEServerTransport(this.legacyMessagesPath, res);

      const sessionId = transport.sessionId;
      const server = this.createSessionServer();
      this.setupToolHandlers(server);
      server.onerror = (error: unknown) => {
        console.error('[Legacy SSE MCP Server Error]', error);
      };

      transport.onclose = async () => {
        const s = this.legacySessions.get(sessionId);
        if (s) {
          this.legacySessions.delete(sessionId);
          await s.server.close();
        }
      };

      this.legacySessions.set(sessionId, { transport, server });
      await server.connect(transport);
      return;
    }

    if (url.pathname === this.legacyMessagesPath) {
      if (method !== 'POST') {
        this.sendHttpError(
          res,
          405,
          `Legacy messages endpoint supports POST only: ${this.legacyMessagesPath}`
        );
        return;
      }

      const sessionId = url.searchParams.get('sessionId') ?? '';
      if (!sessionId) {
        this.sendHttpError(res, 400, 'Missing sessionId query parameter for legacy SSE messages.');
        return;
      }

      const session = this.legacySessions.get(sessionId);
      if (!session) {
        this.sendHttpError(res, 404, `No active legacy SSE session found for sessionId=${sessionId}`);
        return;
      }

      const body = await this.parseJsonBody(req);
      await session.transport.handlePostMessage(req, res, body);
      return;
    }
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
        console.error(`[MCP HTTP Error] ${req.method ?? 'UNKNOWN'} ${req.url ?? '/'} -> ${message}`);
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
      `Postgres MCP server running on Streamable HTTP (${this.accessMode}) at http://${this.sseHost}:${this.ssePort}${this.ssePath}`
    );
    console.error(
      `Legacy SSE compatibility enabled at http://${this.sseHost}:${this.ssePort}${this.legacySsePath} (messages: ${this.legacyMessagesPath})`
    );
  }

  private async startupLog() {
    const conn = await this.db.testConnection();
    const maskedUri = maskConnectionUriPassword(this.databaseUri);
    const maskedPgPassword = process.env.PGPASSWORD ? '******' : '(not set)';

    console.error(
      [
        'Database connected successfully',
        `db=${conn.database}`,
        `user=${conn.current_user}`,
        `host=${conn.server_address ?? 'n/a'}`,
        `port=${conn.server_port ?? 'n/a'}`,
        `accessMode=${this.accessMode}`,
        `transport=${this.transportMode}`,
        maskedUri ? `DATABASE_URI=${maskedUri}` : 'DATABASE_URI=(not set)',
        `PGHOST=${process.env.PGHOST ?? '(not set)'}`,
        `PGPORT=${process.env.PGPORT ?? '(not set)'}`,
        `PGDATABASE=${process.env.PGDATABASE ?? '(not set)'}`,
        `PGUSER=${process.env.PGUSER ?? '(not set)'}`,
        `PGPASSWORD=${maskedPgPassword}`,
      ].join(' | ')
    );
  }

  private async shutdown() {
    for (const [sessionId, session] of this.legacySessions.entries()) {
      try {
        await session.transport.close();
        await session.server.close();
      } finally {
        this.legacySessions.delete(sessionId);
      }
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer?.close(() => resolve()));
      this.httpServer = undefined;
    }
    if (this.httpTransport) {
      await this.httpTransport.close();
      this.httpTransport = undefined;
    }
    await this.db.close();
    await this.server.close();
  }

  async run() {
    await this.startupLog();

    if (this.transportMode === 'sse') {
      await this.runSseHttp();
      return;
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`Postgres MCP server running on stdio (${this.accessMode})`);
  }
}

const server = new PostgresMcpServer();
server.run().catch((error) => {
  console.error('Fatal error running Postgres MCP server:', error);
  process.exit(1);
});
