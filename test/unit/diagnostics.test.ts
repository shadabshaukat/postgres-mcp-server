import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzePlan, buildExplainSql, parseExplainDocument } from '../../src/diagnostics.js';

test('builds safe JSON EXPLAIN statements', () => {
  const planned = buildExplainSql('SELECT * FROM accounts', false);
  assert.match(planned, /FORMAT JSON/);
  assert.match(planned, /ANALYZE FALSE/);
  assert.match(planned, /BUFFERS FALSE/);

  const analyzed = buildExplainSql('SELECT * FROM accounts', true);
  assert.match(analyzed, /ANALYZE TRUE/);
  assert.match(analyzed, /BUFFERS TRUE/);
});

test('parses and analyzes PostgreSQL JSON plans', () => {
  const document = parseExplainDocument([
    {
      'QUERY PLAN': [
        {
          Plan: {
            'Node Type': 'Seq Scan',
            Schema: 'public',
            'Relation Name': 'events',
            'Plan Rows': 1000,
            'Actual Rows': 20000,
            'Rows Removed by Filter': 150000,
            'Total Cost': 9000,
            Filter: '(customer_id = 42)',
          },
          'Planning Time': 1.2,
          'Execution Time': 180.4,
        },
      ],
    },
  ]);
  const analysis = analyzePlan(document);
  assert.equal(analysis.summary.nodeCount, 1);
  assert.equal(analysis.summary.executionTimeMs, 180.4);
  assert.ok(analysis.findings.some((finding) => finding.code === 'large_sequential_scan'));
  assert.ok(analysis.findings.some((finding) => finding.code === 'row_estimate_mismatch'));
  assert.deepEqual(analysis.indexCandidates[0]?.columns, ['customer_id']);
});

test('reports disk-backed sorts as critical', () => {
  const analysis = analyzePlan({
    Plan: {
      'Node Type': 'Sort',
      'Plan Rows': 50000,
      'Sort Method': 'external merge',
      'Temp Written Blocks': 500,
      'Total Cost': 2000,
    },
  });
  assert.ok(
    analysis.findings.some(
      (finding) => finding.code === 'disk_sort' && finding.severity === 'critical'
    )
  );
});
