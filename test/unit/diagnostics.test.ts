import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzePlan,
  buildExplainSql,
  comparePlans,
  parseExplainDocument,
  planFingerprint,
} from '../../src/diagnostics.js';

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

test('normalizes literals in structural plan fingerprints', () => {
  const first = {
    Plan: {
      'Node Type': 'Index Scan',
      Schema: 'public',
      'Relation Name': 'accounts',
      'Index Name': 'accounts_pkey',
      'Index Cond': '(id = 1)',
    },
  };
  const second = {
    Plan: {
      'Node Type': 'Index Scan',
      Schema: 'public',
      'Relation Name': 'accounts',
      'Index Name': 'accounts_pkey',
      'Index Cond': '(id = 900)',
    },
  };
  assert.equal(planFingerprint(first), planFingerprint(second));
});

test('compares plan structure, cost, and diagnostic risk', () => {
  const comparison = comparePlans(
    {
      Plan: {
        'Node Type': 'Seq Scan',
        Schema: 'public',
        'Relation Name': 'events',
        'Plan Rows': 20_000,
        'Total Cost': 1000,
        Filter: '(account_id = 10)',
      },
    },
    {
      Plan: {
        'Node Type': 'Index Scan',
        Schema: 'public',
        'Relation Name': 'events',
        'Index Name': 'events_account_id_idx',
        'Plan Rows': 200,
        'Total Cost': 100,
        'Index Cond': '(account_id = 10)',
      },
    }
  );
  assert.equal(comparison.verdict, 'improved');
  assert.equal(comparison.structuralChange, true);
  assert.equal(comparison.deltas.totalCostPercent, -90);
  assert.ok(comparison.nodeTypeChanges.some((change) => change.nodeType === 'Seq Scan'));
});
