import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { AppConfig } from './config.js';
import { SERVER_NAME, SERVER_VERSION } from './config.js';
import { analyzePlan, buildExplainSql, parseExplainDocument } from './diagnostics.js';
import type { Database, SqlParameter } from './database.js';
import {
  enforceDiagnosticSql,
  enforceSqlPolicy,
  toBoundedLimit,
  wrapWithLimit,
} from './sql-policy.js';

export type ObjectType =
  | 'table'
  | 'view'
  | 'materialized_view'
  | 'sequence'
  | 'function'
  | 'index'
  | 'extension';

const OBJECT_TYPES = new Set<ObjectType>([
  'table',
  'view',
  'materialized_view',
  'sequence',
  'function',
  'index',
  'extension',
]);

export interface ExecuteSqlInput {
  sql: string;
  params?: SqlParameter[];
  limit?: number;
}

export interface ExplainInput {
  sql: string;
  params?: SqlParameter[];
  analyze?: boolean;
}

const quoteIdentifier = (value: string): string => `"${value.replace(/"/g, '""')}"`;

export class PostgresService {
  constructor(
    private readonly database: Database,
    private readonly config: AppConfig
  ) {}

  async serverInfo() {
    const identity = await this.database.testConnection();
    return {
      server: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        accessMode: this.config.accessMode,
        transportMode: this.config.transportMode,
        endpoint:
          this.config.transportMode === 'http'
            ? `http://${this.config.http.host}:${this.config.http.port}${this.config.http.path}`
            : null,
      },
      database: identity,
      safeguards: {
        databaseEnforcedReadOnly: this.config.accessMode === 'restricted',
        statementTimeoutMs: this.config.database.statementTimeoutMs,
        lockTimeoutMs: this.config.database.lockTimeoutMs,
        maxRows: this.config.database.maxRows,
        maxResultBytes: this.config.database.maxResultBytes,
        explainAnalyzeEnabled: this.config.allowExplainAnalyze,
      },
      pool: this.database.poolStats(),
    };
  }

  async listSchemas(includeSystem = false) {
    const result = await this.database.query<{
      schema_name: string;
      owner: string;
      can_use: boolean;
      can_create: boolean;
    }>(`
      SELECT
        n.nspname AS schema_name,
        pg_get_userbyid(n.nspowner) AS owner,
        has_schema_privilege(n.oid, 'USAGE') AS can_use,
        has_schema_privilege(n.oid, 'CREATE') AS can_create
      FROM pg_catalog.pg_namespace n
      WHERE $1::boolean
         OR (
           n.nspname <> 'information_schema'
           AND n.nspname NOT LIKE 'pg_%'
         )
      ORDER BY n.nspname
    `, [includeSystem]);
    return { includeSystem, count: result.rows.length, schemas: result.rows };
  }

  async listObjects(schema: string, objectType: ObjectType) {
    if (!schema.trim()) throw new McpError(ErrorCode.InvalidParams, 'schema must be non-empty.');
    if (!OBJECT_TYPES.has(objectType)) {
      throw new McpError(ErrorCode.InvalidParams, `Unsupported object type: ${objectType}`);
    }

    if (objectType === 'extension') {
      const extensions = await this.listExtensions();
      return {
        schema,
        objectType,
        count: extensions.extensions.filter((item) => item.extension_schema === schema).length,
        objects: extensions.extensions.filter((item) => item.extension_schema === schema),
      };
    }

    if (objectType === 'function') {
      const result = await this.database.query(`
        SELECT
          n.nspname AS schema_name,
          p.proname AS object_name,
          pg_get_function_identity_arguments(p.oid) AS identity_arguments,
          pg_get_function_result(p.oid) AS result_type,
          p.prokind AS function_kind,
          p.provolatile AS volatility
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1
        ORDER BY p.proname, identity_arguments
      `, [schema]);
      return { schema, objectType, count: result.rows.length, objects: result.rows };
    }

    const relkindByType: Record<Exclude<ObjectType, 'function' | 'extension'>, string[]> = {
      table: ['r', 'p', 'f'],
      view: ['v'],
      materialized_view: ['m'],
      sequence: ['S'],
      index: ['i', 'I'],
    };
    const result = await this.database.query(`
      SELECT
        n.nspname AS schema_name,
        c.relname AS object_name,
        CASE c.relkind
          WHEN 'r' THEN 'table'
          WHEN 'p' THEN 'partitioned_table'
          WHEN 'f' THEN 'foreign_table'
          WHEN 'v' THEN 'view'
          WHEN 'm' THEN 'materialized_view'
          WHEN 'S' THEN 'sequence'
          WHEN 'i' THEN 'index'
          WHEN 'I' THEN 'partitioned_index'
          ELSE c.relkind::text
        END AS object_kind,
        pg_get_userbyid(c.relowner) AS owner,
        pg_total_relation_size(c.oid)::text AS total_bytes,
        obj_description(c.oid, 'pg_class') AS comment
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = ANY($2::"char"[])
      ORDER BY c.relname
    `, [schema, relkindByType[objectType]]);
    return { schema, objectType, count: result.rows.length, objects: result.rows };
  }

  async getObjectDetails(schema: string, objectName: string, objectType: ObjectType) {
    if (!schema.trim() || !objectName.trim()) {
      throw new McpError(ErrorCode.InvalidParams, 'schema and objectName must be non-empty.');
    }
    if (!OBJECT_TYPES.has(objectType)) {
      throw new McpError(ErrorCode.InvalidParams, `Unsupported object type: ${objectType}`);
    }

    if (objectType === 'extension') {
      const extensions = await this.listExtensions();
      return {
        basic: { schema, objectName, objectType },
        details:
          extensions.extensions.find(
            (item) => item.extension_schema === schema && item.extension_name === objectName
          ) ?? null,
      };
    }

    if (objectType === 'function') {
      const functions = await this.database.query(`
        SELECT
          p.proname,
          pg_get_function_identity_arguments(p.oid) AS identity_arguments,
          pg_get_function_result(p.oid) AS result_type,
          pg_get_functiondef(p.oid) AS definition,
          p.prokind,
          p.provolatile,
          p.prosecdef AS security_definer
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND p.proname = $2
        ORDER BY identity_arguments
      `, [schema, objectName]);
      return { basic: { schema, objectName, objectType }, functions: functions.rows };
    }

    const relation = await this.database.query(`
      SELECT
        c.oid::text AS oid,
        c.relkind,
        pg_get_userbyid(c.relowner) AS owner,
        c.reltuples::bigint::text AS estimated_rows,
        pg_relation_size(c.oid)::text AS relation_bytes,
        pg_total_relation_size(c.oid)::text AS total_bytes,
        obj_description(c.oid, 'pg_class') AS comment
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2
    `, [schema, objectName]);

    const columns = await this.database.query(`
      SELECT
        a.attnum AS ordinal_position,
        a.attname AS column_name,
        pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
        NOT a.attnotnull AS is_nullable,
        pg_get_expr(d.adbin, d.adrelid) AS column_default,
        a.attidentity AS identity_kind,
        a.attgenerated AS generated_kind,
        col_description(a.attrelid, a.attnum) AS comment
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = $1
        AND c.relname = $2
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY a.attnum
    `, [schema, objectName]);

    const constraints = await this.database.query(`
      SELECT
        con.conname AS constraint_name,
        con.contype AS constraint_type,
        pg_get_constraintdef(con.oid, true) AS definition,
        con.condeferrable AS is_deferrable,
        con.condeferred AS initially_deferred,
        con.convalidated AS is_validated
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2
      ORDER BY con.conname
    `, [schema, objectName]);

    const indexes = await this.database.query(`
      SELECT
        i.indexname,
        i.indexdef,
        COALESCE(s.idx_scan, 0)::text AS scans,
        COALESCE(s.idx_tup_read, 0)::text AS tuples_read,
        COALESCE(s.idx_tup_fetch, 0)::text AS tuples_fetched
      FROM pg_catalog.pg_indexes i
      LEFT JOIN pg_catalog.pg_stat_user_indexes s
        ON s.schemaname = i.schemaname
       AND s.relname = i.tablename
       AND s.indexrelname = i.indexname
      WHERE i.schemaname = $1 AND i.tablename = $2
      ORDER BY i.indexname
    `, [schema, objectName]);

    return {
      basic: { schema, objectName, objectType },
      relation: relation.rows[0] ?? null,
      columns: columns.rows,
      constraints: constraints.rows,
      indexes: indexes.rows,
    };
  }

  async listExtensions() {
    const result = await this.database.query<{
      extension_name: string;
      extension_version: string;
      extension_schema: string;
      comment: string | null;
    }>(`
      SELECT
        e.extname AS extension_name,
        e.extversion AS extension_version,
        n.nspname AS extension_schema,
        obj_description(e.oid, 'pg_extension') AS comment
      FROM pg_catalog.pg_extension e
      JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
      ORDER BY e.extname
    `);
    return { count: result.rows.length, extensions: result.rows };
  }

  async executeSql(input: ExecuteSqlInput, signal?: AbortSignal) {
    const inspection = enforceSqlPolicy(
      input.sql,
      this.config.accessMode,
      this.config.allowExplainAnalyze
    );
    const limit = toBoundedLimit(input.limit, Math.min(100, this.config.database.maxRows), this.config.database.maxRows);
    const canLimit = ['select', 'with', 'values'].includes(inspection.statementType);
    const executionSql = canLimit ? wrapWithLimit(inspection, limit + 1) : inspection.sql;
    const result = await this.database.execute(executionSql, input.params ?? [], {
      readOnly: this.config.accessMode === 'restricted',
      signal,
    });
    const truncated = canLimit && result.rows.length > limit;
    const rows = truncated ? result.rows.slice(0, limit) : result.rows;
    this.database.assertResultSize(rows);
    return {
      accessMode: this.config.accessMode,
      statementType: inspection.statementType,
      command: result.command,
      rowCount: rows.length,
      limitApplied: canLimit ? limit : null,
      truncated,
      rows,
    };
  }

  async explainQuery(input: ExplainInput, signal?: AbortSignal) {
    const inspection = enforceDiagnosticSql(input.sql);
    const analyze = input.analyze === true;
    if (analyze && !this.config.allowExplainAnalyze) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'analyze=true is disabled. Set MCP_ALLOW_EXPLAIN_ANALYZE=true to opt in.'
      );
    }
    const result = await this.database.execute<Record<string, unknown>>(
      buildExplainSql(inspection.sql, analyze),
      input.params ?? [],
      { readOnly: true, signal }
    );
    const plan = parseExplainDocument(result.rows);
    return { analyze, plan, analysis: analyzePlan(plan) };
  }

  async diagnoseQuery(input: ExplainInput, signal?: AbortSignal) {
    const explained = await this.explainQuery(input, signal);
    return {
      analyze: explained.analyze,
      summary: explained.analysis.summary,
      findings: explained.analysis.findings,
      indexCandidates: explained.analysis.indexCandidates,
      nodes: explained.analysis.nodes,
      rawPlan: explained.plan,
      note:
        explained.analysis.indexCandidates.length > 0
          ? 'Index candidates are advisory. Validate with representative data and a hypothetical-index extension such as HypoPG before creating an index.'
          : 'No obvious index candidate was inferred from this plan.',
    };
  }

  async listSlowQueries(limit = 20, orderBy = 'total_exec_time') {
    const extension = await this.database.query<{ schema_name: string }>(`
      SELECT n.nspname AS schema_name
      FROM pg_catalog.pg_extension e
      JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = 'pg_stat_statements'
    `);
    const schemaName = extension.rows[0]?.schema_name;
    if (!schemaName) {
      return {
        available: false,
        reason:
          'pg_stat_statements is not installed in this database. Load it through shared_preload_libraries and run CREATE EXTENSION pg_stat_statements.',
        queries: [],
      };
    }

    const allowedOrder = new Set(['total_exec_time', 'mean_exec_time', 'calls', 'shared_blks_read']);
    if (!allowedOrder.has(orderBy)) {
      throw new McpError(ErrorCode.InvalidParams, 'Unsupported slow-query ordering.');
    }
    const bounded = toBoundedLimit(limit, 20, 100);
    const view = `${quoteIdentifier(schemaName)}.${quoteIdentifier('pg_stat_statements')}`;
    const result = await this.database.query(`
      SELECT
        queryid::text AS query_id,
        calls::text AS calls,
        round(total_exec_time::numeric, 3)::text AS total_exec_time_ms,
        round(mean_exec_time::numeric, 3)::text AS mean_exec_time_ms,
        rows::text AS rows,
        shared_blks_hit::text AS shared_blocks_hit,
        shared_blks_read::text AS shared_blocks_read,
        temp_blks_read::text AS temp_blocks_read,
        temp_blks_written::text AS temp_blocks_written,
        left(query, 4000) AS query
      FROM ${view}
      WHERE dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
        AND query NOT ILIKE '%pg_stat_statements%'
      ORDER BY ${orderBy} DESC
      LIMIT $1
    `, [bounded]);
    return { available: true, orderBy, count: result.rows.length, queries: result.rows };
  }

  async databaseHealth() {
    const identity = await this.database.testConnection();
    const overview = await this.database.query(`
      SELECT
        pg_database_size(current_database())::text AS database_bytes,
        (SELECT count(*)::text FROM pg_catalog.pg_stat_activity WHERE datname = current_database()) AS connections,
        current_setting('max_connections') AS max_connections,
        COALESCE(round(100 * blks_hit::numeric / NULLIF(blks_hit + blks_read, 0), 2), 100)::text AS cache_hit_percent,
        xact_commit::text AS transactions_committed,
        xact_rollback::text AS transactions_rolled_back,
        deadlocks::text AS deadlocks,
        temp_bytes::text AS temp_bytes
      FROM pg_catalog.pg_stat_database
      WHERE datname = current_database()
    `);
    const activity = await this.database.query(`
      SELECT
        count(*) FILTER (WHERE state = 'active')::text AS active,
        count(*) FILTER (WHERE state = 'idle in transaction')::text AS idle_in_transaction,
        count(*) FILTER (WHERE wait_event_type = 'Lock')::text AS waiting_on_lock,
        COALESCE(max(EXTRACT(EPOCH FROM (clock_timestamp() - query_start))) FILTER (WHERE state = 'active'), 0)::numeric(12,3)::text AS longest_active_seconds
      FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database()
    `);
    const maintenance = await this.database.query(`
      SELECT
        schemaname,
        relname,
        n_live_tup::text AS live_rows,
        n_dead_tup::text AS dead_rows,
        last_autovacuum,
        last_autoanalyze
      FROM pg_catalog.pg_stat_user_tables
      ORDER BY n_dead_tup DESC
      LIMIT 10
    `);
    return {
      status: Number(activity.rows[0]?.waiting_on_lock ?? 0) > 0 ? 'degraded' : 'healthy',
      database: identity,
      overview: overview.rows[0] ?? null,
      activity: activity.rows[0] ?? null,
      maintenance: maintenance.rows,
      pool: this.database.poolStats(),
    };
  }

  async catalogResource() {
    const schemas = await this.listSchemas(false);
    return {
      database: (await this.database.testConnection()).database,
      schemas: schemas.schemas,
      supportedObjectTypes: [
        'table',
        'view',
        'materialized_view',
        'sequence',
        'function',
        'index',
        'extension',
      ],
    };
  }
}
