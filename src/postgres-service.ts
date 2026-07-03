import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { AppConfig } from './config.js';
import { SERVER_NAME, SERVER_VERSION } from './config.js';
import { analyzePlan, buildExplainSql, comparePlans, parseExplainDocument } from './diagnostics.js';
import type { Database, SqlParameter } from './database.js';
import {
  buildIndexSql,
  calculateHypotheticalBenefit,
  findCoveringIndex,
  quoteIdentifier,
  recommendationConfidence,
  type ExistingIndex,
} from './index-advisor.js';
import { evaluateHealth, formatPrometheusMetrics } from './monitoring.js';
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

export interface CompareQueryPlansInput {
  baselineSql: string;
  baselineParams?: SqlParameter[];
  candidateSql: string;
  candidateParams?: SqlParameter[];
  analyze?: boolean;
}

export interface RecommendIndexesInput {
  sql: string;
  params?: SqlParameter[];
  maxCandidates?: number;
  validateWithHypopg?: boolean;
}

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
      monitoring: {
        thresholds: this.config.monitoring,
        prometheusMetricsEnabled: this.config.http.metricsEnabled,
        prometheusMetricsPath: this.config.http.metricsEnabled ? this.config.http.metricsPath : null,
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

  async compareQueryPlans(input: CompareQueryPlansInput, signal?: AbortSignal) {
    const analyze = input.analyze === true;
    const baseline = await this.explainQuery(
      { sql: input.baselineSql, params: input.baselineParams, analyze },
      signal
    );
    const candidate = await this.explainQuery(
      { sql: input.candidateSql, params: input.candidateParams, analyze },
      signal
    );
    return {
      analyze,
      comparison: comparePlans(baseline.plan, candidate.plan),
      baseline: { summary: baseline.analysis.summary, findings: baseline.analysis.findings, plan: baseline.plan },
      candidate: {
        summary: candidate.analysis.summary,
        findings: candidate.analysis.findings,
        plan: candidate.plan,
      },
    };
  }

  private async extensionSchema(extensionName: string): Promise<string | undefined> {
    const extension = await this.database.query<{ schema_name: string }>(`
      SELECT n.nspname AS schema_name
      FROM pg_catalog.pg_extension e
      JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = $1
    `, [extensionName]);
    return extension.rows[0]?.schema_name;
  }

  async recommendIndexes(input: RecommendIndexesInput, signal?: AbortSignal) {
    const inspection = enforceDiagnosticSql(input.sql);
    const explained = await this.explainQuery(
      { sql: inspection.sql, params: input.params, analyze: false },
      signal
    );
    const maxCandidates = toBoundedLimit(input.maxCandidates, 5, 10);
    const candidates = explained.analysis.indexCandidates.slice(0, maxCandidates);
    const currentSchemaResult = await this.database.query<{ schema_name: string }>(
      'SELECT current_schema() AS schema_name'
    );
    const defaultSchema = currentSchemaResult.rows[0]?.schema_name ?? 'public';
    const validateWithHypopg = input.validateWithHypopg !== false;
    const hypopgSchema = validateWithHypopg ? await this.extensionSchema('hypopg') : undefined;
    const recommendations: Array<Record<string, unknown>> = [];

    for (const candidate of candidates) {
      const schema = candidate.schema ?? defaultSchema;
      const indexesResult = await this.database.query<{
        index_name: string;
        definition: string;
        key_columns: string[];
        predicate: string | null;
        is_valid: boolean;
        is_ready: boolean;
        scans: string;
      }>(`
        SELECT
          index_class.relname AS index_name,
          pg_get_indexdef(index_data.indexrelid) AS definition,
          ARRAY(
            SELECT pg_get_indexdef(index_data.indexrelid, key_position, true)
            FROM generate_series(1, index_data.indnkeyatts) AS key_position
            ORDER BY key_position
          ) AS key_columns,
          pg_get_expr(index_data.indpred, index_data.indrelid) AS predicate,
          index_data.indisvalid AS is_valid,
          index_data.indisready AS is_ready,
          COALESCE(index_stats.idx_scan, 0)::text AS scans
        FROM pg_catalog.pg_index index_data
        JOIN pg_catalog.pg_class table_class ON table_class.oid = index_data.indrelid
        JOIN pg_catalog.pg_class index_class ON index_class.oid = index_data.indexrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_class.relnamespace
        LEFT JOIN pg_catalog.pg_stat_user_indexes index_stats
          ON index_stats.indexrelid = index_data.indexrelid
        WHERE namespace.nspname = $1 AND table_class.relname = $2
        ORDER BY index_class.relname
      `, [schema, candidate.relation]);
      const indexes: ExistingIndex[] = indexesResult.rows.map((row) => ({
        indexName: row.index_name,
        definition: row.definition,
        keyColumns: row.key_columns,
        predicate: row.predicate,
        isValid: row.is_valid,
        isReady: row.is_ready,
        scans: Number(row.scans),
      }));
      const coveringIndex = findCoveringIndex(candidate.columns, indexes);
      const relationResult = await this.database.query<{
        estimated_rows: string;
        total_bytes: string;
        sequential_scans: string;
        index_scans: string;
        rows_inserted: string;
        rows_updated: string;
        rows_deleted: string;
      }>(`
        SELECT
          GREATEST(table_class.reltuples, 0)::bigint::text AS estimated_rows,
          pg_total_relation_size(table_class.oid)::text AS total_bytes,
          COALESCE(table_stats.seq_scan, 0)::text AS sequential_scans,
          COALESCE(table_stats.idx_scan, 0)::text AS index_scans,
          COALESCE(table_stats.n_tup_ins, 0)::text AS rows_inserted,
          COALESCE(table_stats.n_tup_upd, 0)::text AS rows_updated,
          COALESCE(table_stats.n_tup_del, 0)::text AS rows_deleted
        FROM pg_catalog.pg_class table_class
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_class.relnamespace
        LEFT JOIN pg_catalog.pg_stat_user_tables table_stats ON table_stats.relid = table_class.oid
        WHERE namespace.nspname = $1 AND table_class.relname = $2
      `, [schema, candidate.relation]);
      const relationStats = relationResult.rows[0] ?? null;
      const matchingNode = explained.analysis.nodes.find(
        (node) => node.relation === `${schema}.${candidate.relation}` || node.relation === candidate.relation
      );
      const tableRows = Number(relationStats?.estimated_rows ?? 0);
      const planRows = matchingNode?.estimatedRows;
      const selectivityPercent =
        planRows !== undefined && tableRows > 0
          ? Number(((planRows / tableRows) * 100).toFixed(2))
          : null;
      const createIndexSql = `${buildIndexSql(schema, candidate.relation, candidate.columns, true)};`;
      let hypotheticalBenefit: ReturnType<typeof calculateHypotheticalBenefit> | null = null;
      let validationError: string | null = null;

      if (!coveringIndex && hypopgSchema) {
        const createFunction = `${quoteIdentifier(hypopgSchema)}.${quoteIdentifier('hypopg_create_index')}`;
        const resetFunction = `${quoteIdentifier(hypopgSchema)}.${quoteIdentifier('hypopg_reset')}`;
        try {
          hypotheticalBenefit = await this.database.withSession(
            { readOnly: true, signal },
            async (client) => {
              await client.query(`SELECT ${resetFunction}()`);
              try {
                const created = await client.query<{ indexname: string }>(
                  `SELECT indexname FROM ${createFunction}($1)`,
                  [buildIndexSql(schema, candidate.relation, candidate.columns, false)]
                );
                const hypotheticalPlanResult = await client.query<Record<string, unknown>>(
                  buildExplainSql(inspection.sql, false),
                  input.params ?? []
                );
                const hypotheticalPlan = parseExplainDocument(hypotheticalPlanResult.rows);
                const hypotheticalAnalysis = analyzePlan(hypotheticalPlan);
                const hypotheticalIndexName = created.rows[0]?.indexname;
                return calculateHypotheticalBenefit(
                  explained.analysis.summary.totalCost,
                  hypotheticalAnalysis.summary.totalCost,
                  hypotheticalAnalysis.nodes.some((node) => node.index === hypotheticalIndexName)
                );
              } finally {
                await client.query(`SELECT ${resetFunction}()`);
              }
            }
          );
        } catch (error) {
          validationError = error instanceof Error ? error.message : String(error);
        }
      }

      const recommendation = coveringIndex
        ? 'already_covered'
        : hypotheticalBenefit && !hypotheticalBenefit.usedHypotheticalIndex
          ? 'not_beneficial'
          : hypotheticalBenefit && (hypotheticalBenefit.costReductionPercent ?? 0) >= 10
            ? 'recommended'
            : 'review';
      recommendations.push({
        schema,
        relation: candidate.relation,
        columns: candidate.columns,
        reason: candidate.reason,
        recommendation,
        confidence: coveringIndex
          ? 'high'
          : recommendationConfidence(hypotheticalBenefit, selectivityPercent),
        selectivityPercent,
        createIndexSql: coveringIndex ? null : createIndexSql,
        coveringIndex: coveringIndex ?? null,
        relationStats,
        existingIndexes: indexes,
        hypotheticalBenefit,
        validationError,
      });
    }

    return {
      baseline: explained.analysis.summary,
      candidateCount: recommendations.length,
      hypopg: {
        requested: validateWithHypopg,
        available: Boolean(hypopgSchema),
        schema: hypopgSchema ?? null,
        note: hypopgSchema
          ? 'Each candidate was evaluated in an isolated backend and reset before connection reuse.'
          : 'Install HypoPG to compare hypothetical and baseline planner cost without creating a real index.',
      },
      recommendations,
      note: 'Recommendations are advisory. Review write overhead, storage, existing migrations, and production workload before applying DDL.',
    };
  }

  async listSlowQueries(limit = 20, orderBy = 'total_exec_time') {
    const schemaName = await this.extensionSchema('pg_stat_statements');
    if (!schemaName) {
      return {
        available: false,
        reason:
          'pg_stat_statements is not installed in this database. Load it through shared_preload_libraries and run CREATE EXTENSION pg_stat_statements.',
        queries: [],
      };
    }

    const allowedOrder = new Set([
      'total_exec_time',
      'mean_exec_time',
      'max_exec_time',
      'stddev_exec_time',
      'calls',
      'shared_blks_read',
      'temp_blks_written',
      'wal_bytes',
    ]);
    if (!allowedOrder.has(orderBy)) {
      throw new McpError(ErrorCode.InvalidParams, 'Unsupported slow-query ordering.');
    }
    const bounded = toBoundedLimit(limit, 20, 100);
    const view = `${quoteIdentifier(schemaName)}.${quoteIdentifier('pg_stat_statements')}`;
    const versionResult = await this.database.query<{ server_version_num: string }>(
      "SELECT current_setting('server_version_num') AS server_version_num"
    );
    const serverVersionNum = Number(versionResult.rows[0]?.server_version_num ?? 0);
    const ioTimeColumns = serverVersionNum >= 170_000
      ? `round((statements.shared_blk_read_time + statements.local_blk_read_time)::numeric, 3)::text
          AS block_read_time_ms,
        round((statements.shared_blk_write_time + statements.local_blk_write_time)::numeric, 3)::text
          AS block_write_time_ms,
        round(statements.temp_blk_read_time::numeric, 3)::text AS temp_block_read_time_ms,
        round(statements.temp_blk_write_time::numeric, 3)::text AS temp_block_write_time_ms`
      : serverVersionNum >= 150_000
        ? `round(statements.blk_read_time::numeric, 3)::text AS block_read_time_ms,
        round(statements.blk_write_time::numeric, 3)::text AS block_write_time_ms,
        round(statements.temp_blk_read_time::numeric, 3)::text AS temp_block_read_time_ms,
        round(statements.temp_blk_write_time::numeric, 3)::text AS temp_block_write_time_ms`
        : `round(statements.blk_read_time::numeric, 3)::text AS block_read_time_ms,
        round(statements.blk_write_time::numeric, 3)::text AS block_write_time_ms,
        NULL::text AS temp_block_read_time_ms,
        NULL::text AS temp_block_write_time_ms`;
    const result = await this.database.query(`
      SELECT
        statements.queryid::text AS query_id,
        roles.rolname AS role_name,
        statements.toplevel,
        statements.plans::text AS plans,
        round(statements.total_plan_time::numeric, 3)::text AS total_plan_time_ms,
        round(statements.mean_plan_time::numeric, 3)::text AS mean_plan_time_ms,
        statements.calls::text AS calls,
        round(statements.total_exec_time::numeric, 3)::text AS total_exec_time_ms,
        round(statements.min_exec_time::numeric, 3)::text AS min_exec_time_ms,
        round(statements.max_exec_time::numeric, 3)::text AS max_exec_time_ms,
        round(statements.mean_exec_time::numeric, 3)::text AS mean_exec_time_ms,
        round(statements.stddev_exec_time::numeric, 3)::text AS stddev_exec_time_ms,
        statements.rows::text AS rows,
        round(statements.rows::numeric / NULLIF(statements.calls, 0), 3)::text AS mean_rows_per_call,
        statements.shared_blks_hit::text AS shared_blocks_hit,
        statements.shared_blks_read::text AS shared_blocks_read,
        statements.shared_blks_dirtied::text AS shared_blocks_dirtied,
        statements.shared_blks_written::text AS shared_blocks_written,
        round(100 * statements.shared_blks_hit::numeric /
          NULLIF(statements.shared_blks_hit + statements.shared_blks_read, 0), 2)::text AS shared_cache_hit_percent,
        statements.local_blks_hit::text AS local_blocks_hit,
        statements.local_blks_read::text AS local_blocks_read,
        statements.temp_blks_read::text AS temp_blocks_read,
        statements.temp_blks_written::text AS temp_blocks_written,
        ((statements.temp_blks_read + statements.temp_blks_written) *
          current_setting('block_size')::bigint)::text AS temp_bytes,
        ${ioTimeColumns},
        statements.wal_records::text AS wal_records,
        statements.wal_fpi::text AS wal_full_page_images,
        statements.wal_bytes::text AS wal_bytes,
        left(statements.query, 4000) AS query
      FROM ${view} statements
      LEFT JOIN pg_catalog.pg_roles roles ON roles.oid = statements.userid
      WHERE statements.dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
        AND statements.query NOT ILIKE '%pg_stat_statements%'
      ORDER BY ${orderBy} DESC
      LIMIT $1
    `, [bounded]);
    let statisticsReset: unknown = null;
    let deallocations: unknown = null;
    try {
      const infoView = `${quoteIdentifier(schemaName)}.${quoteIdentifier('pg_stat_statements_info')}`;
      const info = await this.database.query(`SELECT stats_reset, dealloc::text AS dealloc FROM ${infoView}`);
      statisticsReset = info.rows[0]?.stats_reset ?? null;
      deallocations = info.rows[0]?.dealloc ?? null;
    } catch {
      // Older extension versions may not expose pg_stat_statements_info.
    }
    const settings = await this.database.query(`
      SELECT
        current_setting('pg_stat_statements.track_planning', true) AS track_planning,
        current_setting('track_io_timing', true) AS track_io_timing
    `);
    return {
      available: true,
      orderBy,
      count: result.rows.length,
      statisticsReset,
      deallocations,
      settings: settings.rows[0] ?? null,
      queries: result.rows,
    };
  }

  private async optionalQuery(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<{ available: boolean; rows: Array<Record<string, unknown>>; reason?: string }> {
    try {
      const result = await this.database.query(sql, params);
      return { available: true, rows: result.rows };
    } catch (error) {
      return {
        available: false,
        rows: [],
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async monitorDatabase() {
    const identity = await this.database.testConnection();
    const overview = await this.database.query(`
      SELECT
        pg_database_size(current_database())::text AS database_bytes,
        (SELECT count(*)::text FROM pg_catalog.pg_stat_activity WHERE datname = current_database()) AS connections,
        current_setting('max_connections')::text AS max_connections,
        current_setting('server_version_num')::text AS server_version_num,
        current_setting('autovacuum_freeze_max_age')::text AS autovacuum_freeze_max_age,
        COALESCE(round(100 * blks_hit::numeric / NULLIF(blks_hit + blks_read, 0), 2), 100)::text AS cache_hit_percent,
        blks_read::text AS blocks_read,
        blks_hit::text AS blocks_hit,
        xact_commit::text AS transactions_committed,
        xact_rollback::text AS transactions_rolled_back,
        deadlocks::text AS deadlocks,
        temp_files::text AS temp_files,
        temp_bytes::text AS temp_bytes,
        round(blk_read_time::numeric, 3)::text AS block_read_time_ms,
        round(blk_write_time::numeric, 3)::text AS block_write_time_ms,
        stats_reset
      FROM pg_catalog.pg_stat_database
      WHERE datname = current_database()
    `);
    const activity = await this.database.query(`
      SELECT
        count(*) FILTER (WHERE state = 'active')::text AS active,
        count(*) FILTER (WHERE state = 'idle')::text AS idle,
        count(*) FILTER (WHERE state = 'idle in transaction')::text AS idle_in_transaction,
        count(*) FILTER (WHERE wait_event_type = 'Lock')::text AS waiting_on_lock,
        COALESCE(max(EXTRACT(EPOCH FROM (clock_timestamp() - query_start)))
          FILTER (WHERE state = 'active'), 0)::numeric(12,3)::text AS longest_active_seconds,
        COALESCE(max(EXTRACT(EPOCH FROM (clock_timestamp() - xact_start)))
          FILTER (WHERE state = 'idle in transaction'), 0)::numeric(12,3)::text
          AS longest_idle_transaction_seconds
      FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database()
    `);
    const longRunning = await this.optionalQuery(`
      SELECT
        pid,
        usename AS role_name,
        application_name,
        client_addr::text AS client_address,
        state,
        wait_event_type,
        wait_event,
        backend_type,
        EXTRACT(EPOCH FROM (clock_timestamp() - query_start))::numeric(12,3)::text AS query_seconds,
        EXTRACT(EPOCH FROM (clock_timestamp() - xact_start))::numeric(12,3)::text AS transaction_seconds,
        left(query, 2000) AS query
      FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND (
          (state = 'active' AND query_start < clock_timestamp() - make_interval(secs => $1))
          OR (state = 'idle in transaction' AND xact_start < clock_timestamp() - make_interval(secs => $2))
        )
      ORDER BY COALESCE(query_start, xact_start)
      LIMIT 20
    `, [this.config.monitoring.longQueryWarningSeconds, this.config.monitoring.idleTransactionWarningSeconds]);
    const blockers = await this.optionalQuery(`
      SELECT
        blocked.pid AS blocked_pid,
        blocked.usename AS blocked_role,
        blocking.pid AS blocking_pid,
        blocking.usename AS blocking_role,
        blocked.wait_event_type,
        blocked.wait_event,
        EXTRACT(EPOCH FROM (clock_timestamp() - blocked.query_start))::numeric(12,3)::text
          AS blocked_seconds,
        left(blocked.query, 1000) AS blocked_query,
        left(blocking.query, 1000) AS blocking_query
      FROM pg_catalog.pg_stat_activity blocked
      JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS blocker(blocking_pid) ON true
      JOIN pg_catalog.pg_stat_activity blocking ON blocking.pid = blocker.blocking_pid
      WHERE blocked.datname = current_database()
      ORDER BY blocked.query_start
      LIMIT 20
    `);
    const maintenance = await this.database.query(`
      SELECT
        table_stats.schemaname,
        table_stats.relname,
        table_stats.n_live_tup::text AS live_rows,
        table_stats.n_dead_tup::text AS dead_rows,
        COALESCE(round(100 * table_stats.n_dead_tup::numeric /
          NULLIF(table_stats.n_live_tup + table_stats.n_dead_tup, 0), 2), 0)::text
          AS dead_tuple_percent,
        table_stats.seq_scan::text AS sequential_scans,
        table_stats.idx_scan::text AS index_scans,
        table_stats.n_mod_since_analyze::text AS rows_modified_since_analyze,
        table_stats.last_vacuum,
        table_stats.last_autovacuum,
        table_stats.last_analyze,
        table_stats.last_autoanalyze,
        age(table_class.relfrozenxid)::text AS xid_age,
        round(100 * age(table_class.relfrozenxid)::numeric /
          current_setting('autovacuum_freeze_max_age')::numeric, 2)::text AS xid_age_percent,
        pg_total_relation_size(table_class.oid)::text AS total_bytes
      FROM pg_catalog.pg_stat_user_tables table_stats
      JOIN pg_catalog.pg_class table_class ON table_class.oid = table_stats.relid
      WHERE table_class.relkind IN ('r', 'm')
      ORDER BY
        GREATEST(
          COALESCE(100 * table_stats.n_dead_tup::numeric /
            NULLIF(table_stats.n_live_tup + table_stats.n_dead_tup, 0), 0),
          100 * age(table_class.relfrozenxid)::numeric /
            current_setting('autovacuum_freeze_max_age')::numeric
        ) DESC,
        table_stats.n_dead_tup DESC
      LIMIT 20
    `);
    const serverVersionNum = Number(overview.rows[0]?.server_version_num ?? 0);
    const replication = identity.inRecovery
      ? await this.optionalQuery(`
          SELECT
            status,
            sender_host,
            sender_port,
            slot_name,
            written_lsn::text,
            flushed_lsn::text,
            latest_end_lsn::text,
            latest_end_time,
            last_msg_send_time,
            last_msg_receipt_time
          FROM pg_catalog.pg_stat_wal_receiver
        `)
      : await this.optionalQuery(`
          SELECT
            pid,
            usename AS role_name,
            application_name,
            client_addr::text AS client_address,
            state,
            sync_state,
            write_lag,
            flush_lag,
            replay_lag,
            COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn), 0)::bigint::text
              AS replay_lag_bytes,
            sent_lsn::text,
            write_lsn::text,
            flush_lsn::text,
            replay_lsn::text
          FROM pg_catalog.pg_stat_replication
          ORDER BY application_name, pid
        `);
    const wal = await this.optionalQuery(`
      SELECT
        wal_records::text,
        wal_fpi::text,
        wal_bytes::text,
        wal_buffers_full::text,
        stats_reset
      FROM pg_catalog.pg_stat_wal
    `);
    const checkpoints = serverVersionNum >= 170_000
      ? await this.optionalQuery(`
          SELECT
            num_timed::text AS timed,
            num_requested::text AS requested,
            restartpoints_timed::text,
            restartpoints_req::text AS restartpoints_requested,
            restartpoints_done::text,
            round(write_time::numeric, 3)::text AS write_time_ms,
            round(sync_time::numeric, 3)::text AS sync_time_ms,
            buffers_written::text,
            stats_reset
          FROM pg_catalog.pg_stat_checkpointer
        `)
      : await this.optionalQuery(`
          SELECT
            checkpoints_timed::text AS timed,
            checkpoints_req::text AS requested,
            round(checkpoint_write_time::numeric, 3)::text AS write_time_ms,
            round(checkpoint_sync_time::numeric, 3)::text AS sync_time_ms,
            buffers_checkpoint::text AS buffers_written,
            buffers_clean::text,
            maxwritten_clean::text,
            buffers_backend::text,
            buffers_backend_fsync::text,
            buffers_alloc::text,
            stats_reset
          FROM pg_catalog.pg_stat_bgwriter
        `);
    const io = serverVersionNum >= 160_000
      ? await this.optionalQuery(`
          SELECT
            backend_type,
            object,
            context,
            COALESCE(reads, 0)::text AS reads,
            round(COALESCE(read_time, 0)::numeric, 3)::text AS read_time_ms,
            COALESCE(writes, 0)::text AS writes,
            round(COALESCE(write_time, 0)::numeric, 3)::text AS write_time_ms,
            COALESCE(writebacks, 0)::text AS writebacks,
            COALESCE(extends, 0)::text AS extends,
            COALESCE(hits, 0)::text AS hits,
            COALESCE(evictions, 0)::text AS evictions,
            COALESCE(fsyncs, 0)::text AS fsyncs,
            op_bytes::text,
            stats_reset
          FROM pg_catalog.pg_stat_io
          ORDER BY COALESCE(read_time, 0) + COALESCE(write_time, 0) DESC,
            COALESCE(reads, 0) + COALESCE(writes, 0) DESC
          LIMIT 30
        `)
      : { available: false, rows: [], reason: 'pg_stat_io requires PostgreSQL 16 or newer.' };
    const archiver = await this.optionalQuery(`
      SELECT
        archived_count::text,
        last_archived_wal,
        last_archived_time,
        failed_count::text,
        last_failed_wal,
        last_failed_time,
        stats_reset
      FROM pg_catalog.pg_stat_archiver
    `);
    const pool = this.database.poolStats();
    const health = evaluateHealth(
      {
        overview: overview.rows[0] ?? {},
        activity: activity.rows[0] ?? {},
        maintenance: maintenance.rows,
        replication: identity.inRecovery ? [] : replication.rows,
        pool,
      },
      this.config.monitoring
    );
    return {
      collectedAt: new Date().toISOString(),
      status: health.status,
      health,
      database: identity,
      overview: overview.rows[0] ?? null,
      activity: activity.rows[0] ?? null,
      longRunning,
      blockers,
      maintenance: maintenance.rows,
      replication: identity.inRecovery
        ? { mode: 'standby', connections: [], receiver: replication }
        : { mode: 'primary', connections: replication.rows, receiver: null },
      wal,
      checkpoints,
      io,
      archiver,
      capabilities: {
        serverVersionNum,
        pgStatIo: serverVersionNum >= 160_000,
        pgStatCheckpointer: serverVersionNum >= 170_000,
      },
      pool,
    };
  }

  async databaseHealth() {
    return this.monitorDatabase();
  }

  async prometheusMetrics(): Promise<string> {
    return formatPrometheusMetrics(await this.monitorDatabase());
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
