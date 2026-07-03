import pg from 'pg';
import type { DatabaseConfig } from './config.js';
import { SERVER_NAME, setConnectionUriSslMode } from './config.js';

const { Pool } = pg;

export type SqlParameter = string | number | boolean | null | SqlParameter[] | { [key: string]: unknown };

export interface QueryExecutionOptions {
  readOnly: boolean;
  signal?: AbortSignal;
}

export interface DatabaseIdentity {
  database: string;
  currentUser: string;
  serverAddress: string | null;
  serverPort: number | null;
  serverVersion: string;
  inRecovery: boolean;
}

const byteLength = (value: unknown): number =>
  Buffer.byteLength(
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)),
    'utf8'
  );

export class Database {
  private pool: pg.Pool;
  private connectionString: string | undefined;
  private ssl: pg.PoolConfig['ssl'];

  constructor(private readonly config: DatabaseConfig) {
    this.connectionString = config.connectionString;
    this.ssl = config.ssl;
    this.pool = this.createPool();
  }

  private createPool(): pg.Pool {
    const pool = new Pool({
      connectionString: this.connectionString,
      ssl: this.ssl,
      max: this.config.poolMax,
      idleTimeoutMillis: this.config.idleTimeoutMs,
      connectionTimeoutMillis: this.config.connectionTimeoutMs,
      statement_timeout: this.config.statementTimeoutMs,
      query_timeout: this.config.queryTimeoutMs,
      lock_timeout: this.config.lockTimeoutMs,
      application_name: SERVER_NAME,
    });
    pool.on('error', (error) => console.error('[Database Pool Error]', error));
    return pool;
  }

  private async rebuildWithoutSsl(): Promise<void> {
    await this.pool.end();
    this.connectionString = setConnectionUriSslMode(this.connectionString, 'disable');
    this.ssl = undefined;
    this.pool = this.createPool();
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<pg.QueryResult<T>> {
    return this.pool.query<T>(sql, [...params]);
  }

  async execute<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params: readonly SqlParameter[] = [],
    options: QueryExecutionOptions
  ): Promise<pg.QueryResult<T>> {
    return this.withSession(options, async (client) => {
      const result = await client.query<T>(sql, [...params]);
      this.assertResultSize(result.rows);
      return result;
    });
  }

  async withSession<T>(
    options: QueryExecutionOptions,
    callback: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> {
    if (options.signal?.aborted) throw new Error('Query cancelled before execution.');

    const client = await this.pool.connect();
    let backendPid: number | undefined;
    let abortHandler: (() => void) | undefined;
    let releaseError: Error | undefined;

    try {
      await client.query(options.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      await client.query(
        `SELECT
          set_config('statement_timeout', $1, true),
          set_config('lock_timeout', $2, true),
          set_config('idle_in_transaction_session_timeout', $3, true)`,
        [
          `${this.config.statementTimeoutMs}ms`,
          `${this.config.lockTimeoutMs}ms`,
          `${this.config.queryTimeoutMs}ms`,
        ]
      );
      const backend = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      backendPid = backend.rows[0]?.pid;

      if (options.signal && backendPid !== undefined) {
        abortHandler = () => {
          void this.pool
            .query('SELECT pg_cancel_backend($1)', [backendPid])
            .catch((error) => console.error('[Query Cancellation Error]', error));
        };
        options.signal.addEventListener('abort', abortHandler, { once: true });
      }

      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original database error is more useful than a rollback failure.
      }
      throw error;
    } finally {
      if (options.signal && abortHandler) {
        options.signal.removeEventListener('abort', abortHandler);
      }
      try {
        // Queries are stateless across MCP calls. This also releases session advisory locks,
        // removes temporary objects, and resets settings changed through set_config().
        await client.query('DISCARD ALL');
      } catch (error) {
        releaseError = error instanceof Error ? error : new Error(String(error));
      }
      client.release(releaseError);
    }
  }

  assertResultSize(value: unknown): void {
    const size = byteLength(value);
    if (size > this.config.maxResultBytes) {
      throw new Error(
        `Query result is ${size} bytes, exceeding MCP_MAX_RESULT_BYTES=${this.config.maxResultBytes}. Narrow the query or request fewer rows.`
      );
    }
  }

  async testConnection(): Promise<DatabaseIdentity> {
    const run = async (): Promise<DatabaseIdentity> => {
      const result = await this.query<{
        database: string;
        current_user: string;
        server_address: string | null;
        server_port: number | null;
        server_version: string;
        in_recovery: boolean;
      }>(`
        SELECT
          current_database() AS database,
          current_user AS current_user,
          inet_server_addr()::text AS server_address,
          inet_server_port() AS server_port,
          current_setting('server_version') AS server_version,
          pg_is_in_recovery() AS in_recovery
      `);
      const row = result.rows[0];
      if (!row) throw new Error('Database identity query returned no rows.');
      return {
        database: row.database,
        currentUser: row.current_user,
        serverAddress: row.server_address,
        serverPort: row.server_port,
        serverVersion: row.server_version,
        inRecovery: row.in_recovery,
      };
    };

    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.config.sslFallbackToDisable && /does not support ssl connections/i.test(message)) {
        console.error(
          '[Startup Notice] Database rejected SSL. Retrying with sslmode=disable because MCP_SSL_FALLBACK_TO_DISABLE=true.'
        );
        await this.rebuildWithoutSsl();
        return run();
      }
      throw error;
    }
  }

  poolStats(): { total: number; idle: number; waiting: number } {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
