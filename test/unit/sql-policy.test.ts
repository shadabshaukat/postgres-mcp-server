import assert from 'node:assert/strict';
import test from 'node:test';
import {
  enforceDiagnosticSql,
  enforceSqlPolicy,
  inspectSql,
  wrapWithLimit,
} from '../../src/sql-policy.js';

test('allows semicolons inside literals while rejecting multiple statements', () => {
  const inspected = inspectSql("SELECT 'one;two' AS value;");
  assert.equal(inspected.hasMultipleStatements, false);
  assert.equal(inspected.statementType, 'select');

  assert.throws(
    () => enforceSqlPolicy('SELECT 1; DELETE FROM accounts', 'restricted', false),
    /Only one SQL statement/
  );
});

test('masks comments and dollar-quoted bodies during inspection', () => {
  const inspected = inspectSql('/* DELETE */ SELECT $$a;b$$ AS body; -- UPDATE');
  assert.equal(inspected.statementType, 'select');
  assert.equal(inspected.hasMultipleStatements, false);
});

test('blocks write statements in restricted mode', () => {
  for (const sql of [
    'DELETE FROM accounts',
    'UPDATE accounts SET active = false',
    'INSERT INTO accounts(id) VALUES (1)',
    'CREATE TABLE surprise(id int)',
  ]) {
    assert.throws(() => enforceSqlPolicy(sql, 'restricted', false), /Restricted mode permits/);
  }
});

test('blocks EXPLAIN ANALYZE unless explicitly enabled', () => {
  assert.throws(
    () => enforceSqlPolicy('EXPLAIN ANALYZE DELETE FROM accounts', 'restricted', false),
    /EXPLAIN ANALYZE executes/
  );
  assert.equal(
    enforceSqlPolicy('EXPLAIN (ANALYZE TRUE, FORMAT JSON) SELECT 1', 'restricted', true)
      .explainAnalyze,
    true
  );
});

test('diagnostics accept query statements only', () => {
  assert.equal(enforceDiagnosticSql('WITH x AS (SELECT 1) SELECT * FROM x').statementType, 'with');
  assert.throws(() => enforceDiagnosticSql('DELETE FROM accounts'), /diagnostics accept/i);
});

test('wraps row-producing statements with a server limit', () => {
  const inspected = enforceSqlPolicy('SELECT * FROM accounts', 'restricted', false);
  assert.equal(
    wrapWithLimit(inspected, 101),
    'SELECT * FROM (SELECT * FROM accounts) AS _mcp_query LIMIT 101'
  );
});

test('rejects unterminated SQL constructs', () => {
  assert.throws(() => inspectSql("SELECT 'unfinished"), /unterminated/);
  assert.throws(() => inspectSql('SELECT /* unfinished'), /unterminated/);
});
