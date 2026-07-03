export type HealthSeverity = 'warning' | 'critical';

export interface MonitoringThresholds {
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

export interface HealthFinding {
  code: string;
  severity: HealthSeverity;
  message: string;
  metric: string;
  value: number;
  threshold: number;
}

export interface HealthEvaluationInput {
  overview: Record<string, unknown>;
  activity: Record<string, unknown>;
  maintenance: Array<Record<string, unknown>>;
  replication: Array<Record<string, unknown>>;
  pool: { total: number; idle: number; waiting: number };
}

export interface HealthEvaluation {
  status: 'healthy' | 'degraded' | 'critical';
  score: number;
  findings: HealthFinding[];
}

export interface MetricsSnapshot {
  health: HealthEvaluation;
  overview: Record<string, unknown>;
  activity: Record<string, unknown>;
  maintenance: Array<Record<string, unknown>>;
  replication: { connections?: Array<Record<string, unknown>> };
  pool: { total: number; idle: number; waiting: number };
}

const numeric = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const evaluateHealth = (
  input: HealthEvaluationInput,
  thresholds: MonitoringThresholds
): HealthEvaluation => {
  const findings: HealthFinding[] = [];
  let score = 100;
  const add = (
    code: string,
    severity: HealthSeverity,
    message: string,
    metric: string,
    value: number,
    threshold: number,
    deduction: number
  ): void => {
    findings.push({ code, severity, message, metric, value, threshold });
    score -= deduction;
  };

  const connections = numeric(input.overview.connections);
  const maxConnections = Math.max(1, numeric(input.overview.max_connections));
  const connectionPercent = (connections / maxConnections) * 100;
  if (connectionPercent >= thresholds.connectionCriticalPercent) {
    add(
      'connection_saturation',
      'critical',
      `Connection utilization is ${connectionPercent.toFixed(1)}%.`,
      'connection_utilization_percent',
      connectionPercent,
      thresholds.connectionCriticalPercent,
      35
    );
  } else if (connectionPercent >= thresholds.connectionWarningPercent) {
    add(
      'connection_pressure',
      'warning',
      `Connection utilization is ${connectionPercent.toFixed(1)}%.`,
      'connection_utilization_percent',
      connectionPercent,
      thresholds.connectionWarningPercent,
      15
    );
  }

  const waitingOnLock = numeric(input.activity.waiting_on_lock);
  if (waitingOnLock > 0) {
    add(
      'lock_waits',
      waitingOnLock >= 5 ? 'critical' : 'warning',
      `${waitingOnLock} session(s) are waiting on locks.`,
      'waiting_on_lock',
      waitingOnLock,
      1,
      waitingOnLock >= 5 ? 30 : 15
    );
  }

  const longestActive = numeric(input.activity.longest_active_seconds);
  if (longestActive >= thresholds.longQueryCriticalSeconds) {
    add(
      'very_long_query',
      'critical',
      `The longest active query has run for ${longestActive.toFixed(1)} seconds.`,
      'longest_active_seconds',
      longestActive,
      thresholds.longQueryCriticalSeconds,
      25
    );
  } else if (longestActive >= thresholds.longQueryWarningSeconds) {
    add(
      'long_query',
      'warning',
      `The longest active query has run for ${longestActive.toFixed(1)} seconds.`,
      'longest_active_seconds',
      longestActive,
      thresholds.longQueryWarningSeconds,
      10
    );
  }

  const longestIdleTransaction = numeric(input.activity.longest_idle_transaction_seconds);
  if (longestIdleTransaction >= thresholds.idleTransactionWarningSeconds) {
    add(
      'idle_transaction',
      longestIdleTransaction >= thresholds.idleTransactionWarningSeconds * 5 ? 'critical' : 'warning',
      `The longest idle transaction has been open for ${longestIdleTransaction.toFixed(1)} seconds.`,
      'longest_idle_transaction_seconds',
      longestIdleTransaction,
      thresholds.idleTransactionWarningSeconds,
      longestIdleTransaction >= thresholds.idleTransactionWarningSeconds * 5 ? 25 : 12
    );
  }

  const blocksRead = numeric(input.overview.blocks_read);
  const blocksHit = numeric(input.overview.blocks_hit);
  const cacheHitPercent = numeric(input.overview.cache_hit_percent);
  if (blocksRead + blocksHit >= 10_000 && cacheHitPercent < thresholds.cacheHitWarningPercent) {
    add(
      'low_cache_hit_ratio',
      cacheHitPercent < Math.max(0, thresholds.cacheHitWarningPercent - 10) ? 'critical' : 'warning',
      `Database buffer cache hit ratio is ${cacheHitPercent.toFixed(2)}%.`,
      'cache_hit_percent',
      cacheHitPercent,
      thresholds.cacheHitWarningPercent,
      cacheHitPercent < Math.max(0, thresholds.cacheHitWarningPercent - 10) ? 20 : 10
    );
  }

  if (input.pool.waiting > 0) {
    add(
      'mcp_pool_waiting',
      'warning',
      `${input.pool.waiting} MCP request(s) are waiting for a pooled connection.`,
      'pool_waiting',
      input.pool.waiting,
      1,
      12
    );
  }

  const worstDeadTuplePercent = Math.max(
    0,
    ...input.maintenance.map((row) => numeric(row.dead_tuple_percent))
  );
  if (worstDeadTuplePercent >= thresholds.deadTupleWarningPercent) {
    add(
      'dead_tuple_pressure',
      worstDeadTuplePercent >= thresholds.deadTupleWarningPercent * 2 ? 'critical' : 'warning',
      `A table has ${worstDeadTuplePercent.toFixed(2)}% dead tuples.`,
      'dead_tuple_percent',
      worstDeadTuplePercent,
      thresholds.deadTupleWarningPercent,
      worstDeadTuplePercent >= thresholds.deadTupleWarningPercent * 2 ? 20 : 10
    );
  }

  const worstXidPercent = Math.max(0, ...input.maintenance.map((row) => numeric(row.xid_age_percent)));
  if (worstXidPercent >= thresholds.xidWarningPercent) {
    add(
      'transaction_id_age',
      worstXidPercent >= 95 ? 'critical' : 'warning',
      `A table has reached ${worstXidPercent.toFixed(2)}% of autovacuum_freeze_max_age.`,
      'xid_age_percent',
      worstXidPercent,
      thresholds.xidWarningPercent,
      worstXidPercent >= 95 ? 35 : 18
    );
  }

  const maxReplicationLag = Math.max(
    0,
    ...input.replication.map((row) => numeric(row.replay_lag_bytes))
  );
  if (maxReplicationLag >= thresholds.replicationLagCriticalBytes) {
    add(
      'replication_lag',
      'critical',
      `Replication replay lag is ${maxReplicationLag} bytes.`,
      'replication_lag_bytes',
      maxReplicationLag,
      thresholds.replicationLagCriticalBytes,
      30
    );
  } else if (maxReplicationLag >= thresholds.replicationLagWarningBytes) {
    add(
      'replication_lag',
      'warning',
      `Replication replay lag is ${maxReplicationLag} bytes.`,
      'replication_lag_bytes',
      maxReplicationLag,
      thresholds.replicationLagWarningBytes,
      15
    );
  }

  score = Math.max(0, score);
  const status = findings.some((finding) => finding.severity === 'critical')
    ? 'critical'
    : findings.length > 0
      ? 'degraded'
      : 'healthy';
  return { status, score, findings };
};

const metricLine = (
  name: string,
  help: string,
  value: unknown,
  type: 'gauge' | 'counter'
): string[] => [
  `# HELP ${name} ${help}`,
  `# TYPE ${name} ${type}`,
  `${name} ${numeric(value)}`,
];

export const formatPrometheusMetrics = (snapshot: MetricsSnapshot): string => {
  const lines: string[] = [];
  const push = (
    name: string,
    help: string,
    value: unknown,
    type: 'gauge' | 'counter' = 'gauge'
  ): void => {
    lines.push(...metricLine(`postgres_mcp_${name}`, help, value, type));
  };

  const connections = numeric(snapshot.overview.connections);
  const maxConnections = Math.max(1, numeric(snapshot.overview.max_connections));
  const deadTuples = snapshot.maintenance.reduce(
    (total, row) => total + numeric(row.dead_rows),
    0
  );
  const maxReplicationLag = Math.max(
    0,
    ...(snapshot.replication.connections ?? []).map((row) => numeric(row.replay_lag_bytes))
  );

  push('health_score', 'Calculated database health score from 0 to 100.', snapshot.health.score);
  push('database_size_bytes', 'Current database size in bytes.', snapshot.overview.database_bytes);
  push('connections', 'Connections to the current database.', connections);
  push('max_connections', 'Configured PostgreSQL max_connections.', maxConnections);
  push('connection_utilization_ratio', 'Current connection utilization ratio.', connections / maxConnections);
  push('cache_hit_ratio', 'PostgreSQL shared-buffer cache hit ratio.', numeric(snapshot.overview.cache_hit_percent) / 100);
  push('transactions_committed_total', 'Committed transactions since statistics reset.', snapshot.overview.transactions_committed, 'counter');
  push('transactions_rolled_back_total', 'Rolled back transactions since statistics reset.', snapshot.overview.transactions_rolled_back, 'counter');
  push('deadlocks_total', 'Deadlocks since statistics reset.', snapshot.overview.deadlocks, 'counter');
  push('temp_bytes_total', 'Temporary bytes written since statistics reset.', snapshot.overview.temp_bytes, 'counter');
  push('active_sessions', 'Active PostgreSQL sessions.', snapshot.activity.active);
  push('idle_in_transaction_sessions', 'Sessions idle in a transaction.', snapshot.activity.idle_in_transaction);
  push('sessions_waiting_on_lock', 'Sessions waiting on PostgreSQL locks.', snapshot.activity.waiting_on_lock);
  push('longest_active_query_seconds', 'Age of the longest active query.', snapshot.activity.longest_active_seconds);
  push('dead_tuples', 'Dead tuples among the monitored maintenance tables.', deadTuples);
  push('replication_replay_lag_bytes', 'Maximum physical replica replay lag in bytes.', maxReplicationLag);
  push('pool_total', 'Total MCP PostgreSQL pool connections.', snapshot.pool.total);
  push('pool_idle', 'Idle MCP PostgreSQL pool connections.', snapshot.pool.idle);
  push('pool_waiting', 'MCP requests waiting for a pool connection.', snapshot.pool.waiting);
  return `${lines.join('\n')}\n`;
};
