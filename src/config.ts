import { createRequire } from 'node:module';
import fs from 'node:fs';
import { URL } from 'node:url';
import type pg from 'pg';

const nodeRequire = createRequire(import.meta.url);
const packageJson = nodeRequire('../package.json') as { name: string; version: string };

export const SERVER_NAME = packageJson.name;
export const SERVER_VERSION = packageJson.version;

export type AccessMode = 'restricted' | 'unrestricted';
export type TransportMode = 'stdio' | 'http';

export interface DatabaseConfig {
  connectionString?: string;
  ssl?: pg.PoolConfig['ssl'];
  poolMax: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  queryTimeoutMs: number;
  maxRows: number;
  maxResultBytes: number;
  sslFallbackToDisable: boolean;
}

export interface HttpConfig {
  host: string;
  port: number;
  path: string;
  legacySseEnabled: boolean;
  legacySsePath: string;
  legacyMessagesPath: string;
  authToken?: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  allowInsecure: boolean;
  maxBodyBytes: number;
  requestTimeoutMs: number;
  maxSessions: number;
  sessionTtlMs: number;
  metricsEnabled: boolean;
  metricsPath: string;
}

export interface MonitoringConfig {
  connectionWarningPercent: number;
  connectionCriticalPercent: number;
  longQueryWarningSeconds: number;
  longQueryCriticalSeconds: number;
  idleTransactionWarningSeconds: number;
  cacheHitWarningPercent: number;
  deadTupleWarningPercent: number;
  xidWarningPercent: number;
  replicationLagWarningBytes: number;
  replicationLagCriticalBytes: number;
}

export interface AppConfig {
  accessMode: AccessMode;
  transportMode: TransportMode;
  database: DatabaseConfig;
  http: HttpConfig;
  monitoring: MonitoringConfig;
  allowExplainAnalyze: boolean;
}

const readCliArg = (argv: string[], name: string): string | undefined => {
  const exactIndex = argv.findIndex((arg) => arg === name);
  if (exactIndex >= 0 && argv[exactIndex + 1]) return argv[exactIndex + 1];
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
};

export const readBoolean = (raw: string | undefined, fallback: boolean): boolean => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${raw}`);
};

const readInteger = (
  raw: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number
): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
};

const readCsv = (raw: string | undefined): string[] =>
  raw
    ? [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))]
    : [];

const normalizePath = (value: string, name: string): string => {
  const path = value.trim();
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
    throw new Error(`${name} must be an absolute URL path.`);
  }
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
};

const maybeReadFile = (pathOrInline: string | undefined): string | undefined => {
  if (!pathOrInline) return undefined;
  if (fs.existsSync(pathOrInline)) return fs.readFileSync(pathOrInline, 'utf8');
  return pathOrInline.replace(/\\n/g, '\n');
};

const buildSslConfig = (env: NodeJS.ProcessEnv): pg.PoolConfig['ssl'] => {
  const mode = env.PGSSLMODE?.trim().toLowerCase();
  if (!mode || mode === 'disable') return undefined;
  if (!['allow', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(mode)) {
    throw new Error(`Unsupported PGSSLMODE: ${env.PGSSLMODE}`);
  }

  const strictByDefault = mode === 'verify-ca' || mode === 'verify-full';
  return {
    rejectUnauthorized: readBoolean(env.PGSSLREJECTUNAUTHORIZED, strictByDefault),
    ca: maybeReadFile(env.PGSSLROOTCERT_PATH ?? env.PGSSLROOTCERT),
    cert: maybeReadFile(env.PGSSLCERT_PATH ?? env.PGSSLCERT),
    key: maybeReadFile(env.PGSSLKEY_PATH ?? env.PGSSLKEY),
  };
};

const normalizeConnectionUriCredentials = (uri: string | undefined): string | undefined => {
  if (!uri) return undefined;
  try {
    const parsed = new URL(uri);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) return uri;
    if (parsed.username) parsed.username = encodeURIComponent(decodeURIComponent(parsed.username));
    if (parsed.password) parsed.password = encodeURIComponent(decodeURIComponent(parsed.password));
    return parsed.toString();
  } catch {
    return uri;
  }
};

const remapLocalhostInContainer = (
  uri: string | undefined,
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean
): string | undefined => {
  if (!uri || !readBoolean(env.MCP_AUTO_REMAP_LOCALHOST, true)) return uri;
  if (!fileExists('/.dockerenv') && !fileExists('/run/.containerenv')) return uri;

  try {
    const parsed = new URL(uri);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      const defaultAlias = fileExists('/run/.containerenv')
        ? 'host.containers.internal'
        : 'host.docker.internal';
      parsed.hostname = env.MCP_CONTAINER_HOST_ALIAS ?? defaultAlias;
    }
    return parsed.toString();
  } catch {
    return uri;
  }
};

export const isLoopbackHost = (host: string): boolean =>
  ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host.trim().toLowerCase());

const normalizeAccessMode = (raw: string | undefined): AccessMode => {
  const mode = (raw ?? 'restricted').trim().toLowerCase();
  if (mode !== 'restricted' && mode !== 'unrestricted') {
    throw new Error(`Invalid access mode: ${raw}. Expected restricted or unrestricted.`);
  }
  return mode;
};

const normalizeTransportMode = (raw: string | undefined): TransportMode => {
  const mode = (raw ?? 'stdio').trim().toLowerCase();
  if (mode === 'stdio') return 'stdio';
  if (mode === 'http' || mode === 'sse') return 'http';
  throw new Error(`Invalid transport mode: ${raw}. Expected stdio or http.`);
};

export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
  fileExists: (path: string) => boolean = fs.existsSync
): AppConfig => {
  const accessMode = normalizeAccessMode(
    readCliArg(argv, '--access-mode') ?? readCliArg(argv, '--db-mode') ?? env.MCP_DB_MODE
  );
  const transportMode = normalizeTransportMode(readCliArg(argv, '--transport') ?? env.MCP_TRANSPORT);
  const host = env.MCP_HTTP_HOST?.trim() || '127.0.0.1';
  const port = readInteger(env.MCP_HTTP_PORT, 8899, 'MCP_HTTP_PORT', 1, 65535);
  const allowInsecure = readBoolean(env.MCP_ALLOW_INSECURE_HTTP, false);
  const authToken = env.MCP_AUTH_TOKEN?.trim() || undefined;
  if (authToken && authToken.length < 16) {
    throw new Error('MCP_AUTH_TOKEN must contain at least 16 characters.');
  }

  const configuredHosts = readCsv(env.MCP_ALLOWED_HOSTS).map((value) => value.toLowerCase());
  const allowedHosts = configuredHosts.length
    ? configuredHosts
    : isLoopbackHost(host)
      ? ['localhost', '127.0.0.1', '::1', '[::1]']
      : [];

  const configuredOrigins = readCsv(env.MCP_ALLOWED_ORIGINS);
  const allowedOrigins = configuredOrigins.length
    ? configuredOrigins
    : isLoopbackHost(host)
      ? [`http://localhost:${port}`, `http://127.0.0.1:${port}`]
      : [];

  if (transportMode === 'http' && !isLoopbackHost(host) && !allowInsecure) {
    if (!authToken) {
      throw new Error(
        'MCP_AUTH_TOKEN is required when MCP_HTTP_HOST is not loopback. Set MCP_ALLOW_INSECURE_HTTP=true only for an isolated development network.'
      );
    }
    if (allowedHosts.length === 0) {
      throw new Error('MCP_ALLOWED_HOSTS is required when exposing HTTP beyond loopback.');
    }
  }

  const rawUri = env.DATABASE_URI ?? env.POSTGRES_URL ?? env.DATABASE_URL;
  const normalizedUri = normalizeConnectionUriCredentials(rawUri);
  const connectionString = remapLocalhostInContainer(normalizedUri, env, fileExists);
  const connectionWarningPercent = readInteger(
    env.MCP_MONITOR_CONNECTION_WARN_PERCENT,
    80,
    'MCP_MONITOR_CONNECTION_WARN_PERCENT',
    1,
    99
  );
  const connectionCriticalPercent = readInteger(
    env.MCP_MONITOR_CONNECTION_CRITICAL_PERCENT,
    95,
    'MCP_MONITOR_CONNECTION_CRITICAL_PERCENT',
    2,
    100
  );
  const longQueryWarningSeconds = readInteger(
    env.MCP_MONITOR_LONG_QUERY_WARN_SECONDS,
    30,
    'MCP_MONITOR_LONG_QUERY_WARN_SECONDS',
    1,
    86_400
  );
  const longQueryCriticalSeconds = readInteger(
    env.MCP_MONITOR_LONG_QUERY_CRITICAL_SECONDS,
    300,
    'MCP_MONITOR_LONG_QUERY_CRITICAL_SECONDS',
    2,
    604_800
  );
  const replicationLagWarningBytes = readInteger(
    env.MCP_MONITOR_REPLICATION_LAG_WARN_BYTES,
    64 * 1024 * 1024,
    'MCP_MONITOR_REPLICATION_LAG_WARN_BYTES',
    1,
    10_000_000_000_000
  );
  const replicationLagCriticalBytes = readInteger(
    env.MCP_MONITOR_REPLICATION_LAG_CRITICAL_BYTES,
    1024 * 1024 * 1024,
    'MCP_MONITOR_REPLICATION_LAG_CRITICAL_BYTES',
    2,
    10_000_000_000_000
  );
  if (connectionWarningPercent >= connectionCriticalPercent) {
    throw new Error('MCP monitor connection warning threshold must be lower than critical.');
  }
  if (longQueryWarningSeconds >= longQueryCriticalSeconds) {
    throw new Error('MCP monitor long-query warning threshold must be lower than critical.');
  }
  if (replicationLagWarningBytes >= replicationLagCriticalBytes) {
    throw new Error('MCP monitor replication-lag warning threshold must be lower than critical.');
  }

  return {
    accessMode,
    transportMode,
    allowExplainAnalyze: readBoolean(env.MCP_ALLOW_EXPLAIN_ANALYZE, false),
    database: {
      connectionString,
      ssl: buildSslConfig(env),
      poolMax: readInteger(env.PGPOOL_MAX, 10, 'PGPOOL_MAX', 1, 100),
      idleTimeoutMs: readInteger(
        env.PGPOOL_IDLE_TIMEOUT_MS,
        30_000,
        'PGPOOL_IDLE_TIMEOUT_MS',
        100,
        3_600_000
      ),
      connectionTimeoutMs: readInteger(
        env.PGPOOL_CONNECTION_TIMEOUT_MS,
        10_000,
        'PGPOOL_CONNECTION_TIMEOUT_MS',
        100,
        300_000
      ),
      statementTimeoutMs: readInteger(
        env.MCP_STATEMENT_TIMEOUT_MS,
        15_000,
        'MCP_STATEMENT_TIMEOUT_MS',
        100,
        3_600_000
      ),
      lockTimeoutMs: readInteger(
        env.MCP_LOCK_TIMEOUT_MS,
        3_000,
        'MCP_LOCK_TIMEOUT_MS',
        50,
        300_000
      ),
      queryTimeoutMs: readInteger(
        env.MCP_QUERY_TIMEOUT_MS,
        20_000,
        'MCP_QUERY_TIMEOUT_MS',
        100,
        3_600_000
      ),
      maxRows: readInteger(env.MCP_MAX_ROWS, 1_000, 'MCP_MAX_ROWS', 1, 50_000),
      maxResultBytes: readInteger(
        env.MCP_MAX_RESULT_BYTES,
        2_000_000,
        'MCP_MAX_RESULT_BYTES',
        1_024,
        100_000_000
      ),
      sslFallbackToDisable: readBoolean(env.MCP_SSL_FALLBACK_TO_DISABLE, false),
    },
    http: {
      host,
      port,
      path: normalizePath(env.MCP_HTTP_PATH ?? '/mcp', 'MCP_HTTP_PATH'),
      legacySseEnabled: readBoolean(env.MCP_ENABLE_LEGACY_SSE, false),
      legacySsePath: normalizePath(env.MCP_LEGACY_SSE_PATH ?? '/sse', 'MCP_LEGACY_SSE_PATH'),
      legacyMessagesPath: normalizePath(
        env.MCP_LEGACY_MESSAGES_PATH ?? '/messages',
        'MCP_LEGACY_MESSAGES_PATH'
      ),
      authToken,
      allowedHosts,
      allowedOrigins,
      allowInsecure,
      maxBodyBytes: readInteger(
        env.MCP_MAX_BODY_BYTES,
        1_000_000,
        'MCP_MAX_BODY_BYTES',
        1_024,
        50_000_000
      ),
      requestTimeoutMs: readInteger(
        env.MCP_REQUEST_TIMEOUT_MS,
        60_000,
        'MCP_REQUEST_TIMEOUT_MS',
        1_000,
        3_600_000
      ),
      maxSessions: readInteger(env.MCP_MAX_SESSIONS, 100, 'MCP_MAX_SESSIONS', 1, 10_000),
      sessionTtlMs: readInteger(
        env.MCP_SESSION_TTL_MS,
        30 * 60_000,
        'MCP_SESSION_TTL_MS',
        10_000,
        24 * 60 * 60_000
      ),
      metricsEnabled: readBoolean(env.MCP_ENABLE_METRICS, false),
      metricsPath: normalizePath(env.MCP_METRICS_PATH ?? '/metrics', 'MCP_METRICS_PATH'),
    },
    monitoring: {
      connectionWarningPercent,
      connectionCriticalPercent,
      longQueryWarningSeconds,
      longQueryCriticalSeconds,
      idleTransactionWarningSeconds: readInteger(
        env.MCP_MONITOR_IDLE_TRANSACTION_WARN_SECONDS,
        60,
        'MCP_MONITOR_IDLE_TRANSACTION_WARN_SECONDS',
        1,
        604_800
      ),
      cacheHitWarningPercent: readInteger(
        env.MCP_MONITOR_CACHE_HIT_WARN_PERCENT,
        95,
        'MCP_MONITOR_CACHE_HIT_WARN_PERCENT',
        1,
        100
      ),
      deadTupleWarningPercent: readInteger(
        env.MCP_MONITOR_DEAD_TUPLE_WARN_PERCENT,
        20,
        'MCP_MONITOR_DEAD_TUPLE_WARN_PERCENT',
        1,
        100
      ),
      xidWarningPercent: readInteger(
        env.MCP_MONITOR_XID_WARN_PERCENT,
        80,
        'MCP_MONITOR_XID_WARN_PERCENT',
        1,
        99
      ),
      replicationLagWarningBytes,
      replicationLagCriticalBytes,
    },
  };
};

export const setConnectionUriSslMode = (
  uri: string | undefined,
  mode: 'disable' | 'require' | 'verify-full'
): string | undefined => {
  if (!uri) return undefined;
  try {
    const parsed = new URL(uri);
    parsed.searchParams.set('sslmode', mode);
    return parsed.toString();
  } catch {
    return uri;
  }
};

export const maskConnectionUri = (uri: string | undefined): string | undefined => {
  if (!uri) return undefined;
  try {
    const parsed = new URL(uri);
    if (parsed.password) parsed.password = '******';
    return parsed.toString();
  } catch {
    return '(invalid database URI)';
  }
};
