import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { AccessMode } from './config.js';

export type StatementType =
  | 'select'
  | 'with'
  | 'show'
  | 'explain'
  | 'values'
  | 'insert'
  | 'update'
  | 'delete'
  | 'merge'
  | 'unknown'
  | string;

export interface SqlInspection {
  sql: string;
  statementType: StatementType;
  explainAnalyze: boolean;
  hasMultipleStatements: boolean;
}

const readDollarTag = (sql: string, index: number): string | undefined => {
  if (sql[index] !== '$') return undefined;
  const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
  return match?.[0];
};

const maskCommentsAndLiterals = (sql: string): { code: string; semicolons: number[] } => {
  let code = '';
  const semicolons: number[] = [];
  let state: 'code' | 'single' | 'double' | 'line-comment' | 'block-comment' | 'dollar' = 'code';
  let dollarTag = '';
  let blockDepth = 0;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (state === 'line-comment') {
      if (char === '\n') {
        state = 'code';
        code += '\n';
      } else {
        code += ' ';
      }
      continue;
    }

    if (state === 'block-comment') {
      if (char === '/' && next === '*') {
        blockDepth += 1;
        code += '  ';
        index += 1;
      } else if (char === '*' && next === '/') {
        blockDepth -= 1;
        code += '  ';
        index += 1;
        if (blockDepth === 0) state = 'code';
      } else {
        code += char === '\n' ? '\n' : ' ';
      }
      continue;
    }

    if (state === 'single') {
      if (char === "'" && next === "'") {
        code += '  ';
        index += 1;
      } else if (char === "'") {
        state = 'code';
        code += ' ';
      } else {
        code += char === '\n' ? '\n' : ' ';
      }
      continue;
    }

    if (state === 'double') {
      if (char === '"' && next === '"') {
        code += '  ';
        index += 1;
      } else if (char === '"') {
        state = 'code';
        code += ' ';
      } else {
        code += char === '\n' ? '\n' : ' ';
      }
      continue;
    }

    if (state === 'dollar') {
      if (sql.startsWith(dollarTag, index)) {
        code += ' '.repeat(dollarTag.length);
        index += dollarTag.length - 1;
        state = 'code';
      } else {
        code += char === '\n' ? '\n' : ' ';
      }
      continue;
    }

    if (char === '-' && next === '-') {
      state = 'line-comment';
      code += '  ';
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      state = 'block-comment';
      blockDepth = 1;
      code += '  ';
      index += 1;
      continue;
    }
    if (char === "'") {
      state = 'single';
      code += ' ';
      continue;
    }
    if (char === '"') {
      state = 'double';
      code += ' ';
      continue;
    }

    const tag = readDollarTag(sql, index);
    if (tag) {
      state = 'dollar';
      dollarTag = tag;
      code += ' '.repeat(tag.length);
      index += tag.length - 1;
      continue;
    }

    if (char === ';') semicolons.push(index);
    code += char;
  }

  if (state === 'single' || state === 'double' || state === 'block-comment' || state === 'dollar') {
    throw new McpError(ErrorCode.InvalidParams, 'SQL contains an unterminated literal or comment.');
  }

  return { code, semicolons };
};

export const inspectSql = (sql: string): SqlInspection => {
  const trimmed = sql.trim();
  if (!trimmed) throw new McpError(ErrorCode.InvalidParams, 'SQL must be non-empty.');

  const { code, semicolons } = maskCommentsAndLiterals(trimmed);
  const codeWithoutTrailingSemicolon = code.replace(/;\s*$/, '').trim();
  const statementType =
    codeWithoutTrailingSemicolon.match(/^([A-Za-z]+)/)?.[1]?.toLowerCase() ?? 'unknown';
  const hasMultipleStatements = semicolons.some((position) => {
    const remaining = code.slice(position + 1).trim();
    return remaining.replace(/^;+/, '').trim().length > 0;
  });
  const explainAnalyze =
    statementType === 'explain' &&
    /^explain\s+(?:analyze\b|\([^)]*\banalyze\b[^)]*\))/i.test(codeWithoutTrailingSemicolon);

  return {
    sql: trimmed.replace(/;+\s*$/, ''),
    statementType,
    explainAnalyze,
    hasMultipleStatements,
  };
};

const TRANSACTION_CONTROL = new Set([
  'begin',
  'start',
  'commit',
  'rollback',
  'savepoint',
  'release',
  'prepare',
]);

const RESTRICTED_STATEMENTS = new Set(['select', 'with', 'show', 'explain', 'values']);
const DIAGNOSTIC_STATEMENTS = new Set(['select', 'with', 'values']);

export const enforceSqlPolicy = (
  sql: string,
  mode: AccessMode,
  allowExplainAnalyze: boolean
): SqlInspection => {
  const inspection = inspectSql(sql);
  if (inspection.hasMultipleStatements) {
    throw new McpError(ErrorCode.InvalidParams, 'Only one SQL statement is allowed per request.');
  }
  if (TRANSACTION_CONTROL.has(inspection.statementType)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Transaction-control statements are managed by the server and cannot be submitted directly.'
    );
  }
  if (mode === 'restricted' && !RESTRICTED_STATEMENTS.has(inspection.statementType)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Restricted mode permits SELECT, WITH, VALUES, SHOW, and EXPLAIN only. Received: ${inspection.statementType}`
    );
  }
  if (inspection.explainAnalyze && !allowExplainAnalyze) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'EXPLAIN ANALYZE executes the statement and is disabled. Use explain_query with analyze=false.'
    );
  }
  return inspection;
};

export const enforceDiagnosticSql = (sql: string): SqlInspection => {
  const inspection = inspectSql(sql);
  if (inspection.hasMultipleStatements) {
    throw new McpError(ErrorCode.InvalidParams, 'Only one SQL statement is allowed per request.');
  }
  if (!DIAGNOSTIC_STATEMENTS.has(inspection.statementType)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Query diagnostics accept SELECT, WITH, or VALUES statements only.'
    );
  }
  return inspection;
};

export const toBoundedLimit = (value: number | undefined, fallback: number, maximum: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), maximum));
};

export const wrapWithLimit = (inspection: SqlInspection, limit: number): string => {
  if (!['select', 'with', 'values'].includes(inspection.statementType)) return inspection.sql;
  return `SELECT * FROM (${inspection.sql}) AS _mcp_query LIMIT ${limit}`;
};
