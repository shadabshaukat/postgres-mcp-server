import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateHealth,
  formatPrometheusMetrics,
  type MonitoringThresholds,
} from '../../src/monitoring.js';

const thresholds: MonitoringThresholds = {
  connectionWarningPercent: 80,
  connectionCriticalPercent: 95,
  longQueryWarningSeconds: 30,
  longQueryCriticalSeconds: 300,
  idleTransactionWarningSeconds: 60,
  cacheHitWarningPercent: 95,
  deadTupleWarningPercent: 20,
  xidWarningPercent: 80,
  replicationLagWarningBytes: 64 * 1024 * 1024,
  replicationLagCriticalBytes: 1024 * 1024 * 1024,
};

test('reports healthy when monitored values are below thresholds', () => {
  const result = evaluateHealth(
    {
      overview: {
        connections: '10',
        max_connections: '100',
        blocks_read: '1000',
        blocks_hit: '99000',
        cache_hit_percent: '99',
      },
      activity: {
        waiting_on_lock: '0',
        longest_active_seconds: '2',
        longest_idle_transaction_seconds: '0',
      },
      maintenance: [{ dead_tuple_percent: '2', xid_age_percent: '5' }],
      replication: [],
      pool: { total: 2, idle: 1, waiting: 0 },
    },
    thresholds
  );
  assert.equal(result.status, 'healthy');
  assert.equal(result.score, 100);
});

test('reports critical with explicit reasons for production pressure', () => {
  const result = evaluateHealth(
    {
      overview: {
        connections: '98',
        max_connections: '100',
        blocks_read: '20000',
        blocks_hit: '1000',
        cache_hit_percent: '4.76',
      },
      activity: {
        waiting_on_lock: '7',
        longest_active_seconds: '600',
        longest_idle_transaction_seconds: '400',
      },
      maintenance: [{ dead_tuple_percent: '55', xid_age_percent: '97' }],
      replication: [{ replay_lag_bytes: String(2 * 1024 * 1024 * 1024) }],
      pool: { total: 10, idle: 0, waiting: 3 },
    },
    thresholds
  );
  assert.equal(result.status, 'critical');
  assert.equal(result.score, 0);
  assert.ok(result.findings.some((finding) => finding.code === 'connection_saturation'));
  assert.ok(result.findings.some((finding) => finding.code === 'transaction_id_age'));
  assert.ok(result.findings.some((finding) => finding.code === 'replication_lag'));
});

test('formats aggregate monitoring values as Prometheus metrics', () => {
  const health = { status: 'healthy' as const, score: 100, findings: [] };
  const text = formatPrometheusMetrics({
    health,
    overview: {
      database_bytes: '4096',
      connections: '5',
      max_connections: '100',
      cache_hit_percent: '99',
    },
    activity: { active: '2', idle_in_transaction: '0', waiting_on_lock: '0' },
    maintenance: [{ dead_rows: '12' }],
    replication: { connections: [{ replay_lag_bytes: '1024' }] },
    pool: { total: 2, idle: 1, waiting: 0 },
  });
  assert.match(text, /postgres_mcp_health_score 100/);
  assert.match(text, /postgres_mcp_connection_utilization_ratio 0\.05/);
  assert.match(text, /postgres_mcp_replication_replay_lag_bytes 1024/);
});
