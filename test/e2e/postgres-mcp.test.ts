import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import test, { after, before } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL;
const projectRoot = new URL('../..', import.meta.url).pathname;

const cleanEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );

const asObject = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};

const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not allocate a test port.'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });

if (!databaseUrl) {
  test('PostgreSQL MCP end-to-end suite', { skip: 'Set TEST_DATABASE_URL to run.' }, () => {});
} else {
  const admin = new Pool({ connectionString: databaseUrl, max: 3 });
  let stdioClient: Client;
  let stdioTransport: StdioClientTransport;

  before(async () => {
    await admin.query('DROP SCHEMA IF EXISTS mcp_test CASCADE');
    await admin.query('CREATE SCHEMA mcp_test');
    await admin.query(`
      CREATE TABLE mcp_test.accounts (
        id integer PRIMARY KEY,
        email text NOT NULL,
        active boolean NOT NULL DEFAULT true
      )
    `);
    await admin.query(`
      CREATE TABLE mcp_test.events (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        account_id integer NOT NULL REFERENCES mcp_test.accounts(id),
        category text NOT NULL,
        payload text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await admin.query('CREATE SEQUENCE mcp_test.safety_sequence');
    await admin.query(`
      INSERT INTO mcp_test.accounts(id, email)
      SELECT value, 'user-' || value || '@example.test'
      FROM generate_series(1, 100) AS value
    `);
    await admin.query(`
      INSERT INTO mcp_test.events(account_id, category, payload)
      SELECT
        ((value - 1) % 100) + 1,
        CASE WHEN value % 20 = 0 THEN 'rare' ELSE 'common' END,
        CASE WHEN value % 10 = 0 THEN 'contains needle' ELSE 'ordinary payload' END
      FROM generate_series(1, 20000) AS value
    `);
    await admin.query('ANALYZE mcp_test.accounts');
    await admin.query('ANALYZE mcp_test.events');
    await admin.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    await admin.query('SELECT count(*) FROM mcp_test.events WHERE category = $1', ['common']);

    stdioTransport = new StdioClientTransport({
      command: process.execPath,
      args: ['build/index.js'],
      cwd: projectRoot,
      env: {
        ...cleanEnvironment(),
        DATABASE_URI: databaseUrl,
        PGSSLMODE: 'disable',
        MCP_TRANSPORT: 'stdio',
        MCP_DB_MODE: 'restricted',
        MCP_ALLOW_EXPLAIN_ANALYZE: 'true',
        MCP_STATEMENT_TIMEOUT_MS: '300',
        MCP_QUERY_TIMEOUT_MS: '1500',
        MCP_MAX_ROWS: '100',
        MCP_MAX_RESULT_BYTES: '1000000',
      },
      stderr: 'pipe',
    });
    stdioTransport.stderr?.on('data', (chunk) => process.stderr.write(`[stdio-server] ${chunk}`));
    stdioClient = new Client({ name: 'postgres-mcp-e2e', version: '1.0.0' });
    await stdioClient.connect(stdioTransport);
  });

  after(async () => {
    await stdioClient?.close().catch(() => undefined);
    await admin.query('DROP SCHEMA IF EXISTS mcp_test CASCADE').catch(() => undefined);
    await admin.end();
  });

  test('advertises tools, structured output, and catalog resources', async () => {
    const tools = await stdioClient.listTools();
    const names = tools.tools.map((tool) => tool.name);
    for (const name of [
      'execute_sql',
      'explain_query',
      'diagnose_query',
      'compare_query_plans',
      'recommend_indexes',
      'list_slow_queries',
      'monitor_database',
      'database_health',
    ]) {
      assert.ok(names.includes(name), `${name} should be advertised`);
    }

    const info = await stdioClient.callTool({ name: 'server_info', arguments: {} });
    assert.equal(info.isError, undefined);
    assert.equal(asObject(asObject(info.structuredContent).server).version, '0.3.0');

    const resources = await stdioClient.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === 'postgres://catalog'));
    const catalog = await stdioClient.readResource({ uri: 'postgres://catalog' });
    const catalogContent = catalog.contents[0];
    assert.ok(catalogContent && 'text' in catalogContent);
    assert.match(catalogContent.text, /mcp_test/);
  });

  test('executes parameterized reads with deterministic row limits', async () => {
    const result = await stdioClient.callTool({
      name: 'execute_sql',
      arguments: {
        sql: 'SELECT id, email FROM mcp_test.accounts WHERE id > $1 ORDER BY id',
        params: [90],
        limit: 5,
      },
    });
    assert.equal(result.isError, undefined);
    const payload = asObject(result.structuredContent);
    assert.equal(payload.rowCount, 5);
    assert.equal(payload.truncated, true);
    assert.equal((payload.rows as Array<Record<string, unknown>>)[0]?.id, 91);
  });

  test('blocks destructive EXPLAIN ANALYZE and mutating SELECT functions', async () => {
    const beforeCount = await admin.query<{ count: string }>('SELECT count(*) FROM mcp_test.accounts');
    const destructive = await stdioClient.callTool({
      name: 'execute_sql',
      arguments: { sql: 'EXPLAIN ANALYZE DELETE FROM mcp_test.accounts' },
    });
    assert.equal(destructive.isError, true);

    const sequenceMutation = await stdioClient.callTool({
      name: 'execute_sql',
      arguments: { sql: "SELECT nextval('mcp_test.safety_sequence')" },
    });
    assert.equal(sequenceMutation.isError, true);

    const afterCount = await admin.query<{ count: string }>('SELECT count(*) FROM mcp_test.accounts');
    const sequenceState = await admin.query<{ is_called: boolean }>(
      'SELECT is_called FROM mcp_test.safety_sequence'
    );
    assert.equal(afterCount.rows[0]?.count, beforeCount.rows[0]?.count);
    assert.equal(sequenceState.rows[0]?.is_called, false);
  });

  test('cleans session-level state before returning pooled connections', async () => {
    const lock = await stdioClient.callTool({
      name: 'execute_sql',
      arguments: { sql: 'SELECT pg_advisory_lock(771122)' },
    });
    assert.equal(lock.isError, undefined);

    const lockProbe = await admin.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(771122) AS acquired'
    );
    assert.equal(lockProbe.rows[0]?.acquired, true);
    await admin.query('SELECT pg_advisory_unlock(771122)');
  });

  test('enforces PostgreSQL statement timeout', async () => {
    const started = Date.now();
    const result = await stdioClient.callTool({
      name: 'execute_sql',
      arguments: { sql: 'SELECT pg_sleep(2)' },
    });
    assert.equal(result.isError, true);
    assert.ok(Date.now() - started < 1_500, 'query should be cancelled by statement_timeout');
  });

  test('returns findings, compares plans, and recommends advisory indexes', async () => {
    const explained = await stdioClient.callTool({
      name: 'explain_query',
      arguments: { sql: 'SELECT * FROM mcp_test.events WHERE account_id = $1', params: [10] },
    });
    assert.equal(explained.isError, undefined);
    assert.ok(asObject(asObject(explained.structuredContent).analysis).summary);

    const diagnosed = await stdioClient.callTool({
      name: 'diagnose_query',
      arguments: {
        sql: "SELECT * FROM mcp_test.events WHERE category = 'common'",
        analyze: true,
      },
    });
    assert.equal(diagnosed.isError, undefined);
    const findings = asObject(diagnosed.structuredContent).findings as Array<Record<string, unknown>>;
    assert.ok(findings.some((finding) => finding.code === 'large_sequential_scan'));

    const compared = await stdioClient.callTool({
      name: 'compare_query_plans',
      arguments: {
        baselineSql: "SELECT * FROM mcp_test.events WHERE category = 'rare'",
        candidateSql: 'SELECT * FROM mcp_test.events WHERE id = $1',
        candidateParams: [1],
      },
    });
    assert.equal(compared.isError, undefined);
    const comparison = asObject(asObject(compared.structuredContent).comparison);
    assert.equal(comparison.structuralChange, true);
    assert.ok(['improved', 'changed'].includes(String(comparison.verdict)));

    const recommended = await stdioClient.callTool({
      name: 'recommend_indexes',
      arguments: {
        sql: "SELECT * FROM mcp_test.events WHERE category = 'rare'",
        validateWithHypopg: true,
      },
    });
    assert.equal(recommended.isError, undefined);
    const recommendationPayload = asObject(recommended.structuredContent);
    assert.ok(Number(recommendationPayload.candidateCount) >= 1);
    assert.equal(asObject(recommendationPayload.hypopg).available, false);
    const recommendations = recommendationPayload.recommendations as Array<Record<string, unknown>>;
    assert.match(String(recommendations[0]?.createIndexSql), /CREATE INDEX CONCURRENTLY/);
  });

  test('reports expanded workload statistics and scored database monitoring', async () => {
    const slow = await stdioClient.callTool({
      name: 'list_slow_queries',
      arguments: { limit: 10, orderBy: 'total_exec_time' },
    });
    assert.equal(slow.isError, undefined, JSON.stringify(slow.content));
    const slowPayload = asObject(slow.structuredContent);
    assert.equal(slowPayload.available, true);
    const slowQueries = slowPayload.queries as Array<Record<string, unknown>>;
    assert.ok(slowQueries.length > 0);
    assert.ok('max_exec_time_ms' in (slowQueries[0] ?? {}));
    assert.ok('wal_bytes' in (slowQueries[0] ?? {}));

    const monitoring = await stdioClient.callTool({ name: 'monitor_database', arguments: {} });
    assert.equal(monitoring.isError, undefined);
    const monitoringPayload = asObject(monitoring.structuredContent);
    assert.ok(['healthy', 'degraded', 'critical'].includes(String(monitoringPayload.status)));
    assert.equal(asObject(monitoringPayload.capabilities).pgStatIo, true);
    assert.equal(asObject(monitoringPayload.io).available, true);
    assert.equal(asObject(monitoringPayload.checkpoints).available, true);

    const health = await stdioClient.callTool({ name: 'database_health', arguments: {} });
    assert.equal(health.isError, undefined);
    assert.ok(
      ['healthy', 'degraded', 'critical'].includes(String(asObject(health.structuredContent).status))
    );
  });

  test('secures Streamable HTTP and exports authenticated Prometheus metrics', async () => {
    const port = await freePort();
    const token = 'e2e-http-secret-token';
    const origin = `http://localhost:${port}`;
    const child: ChildProcess = spawn(process.execPath, ['build/index.js'], {
      cwd: projectRoot,
      env: {
        ...cleanEnvironment(),
        DATABASE_URI: databaseUrl,
        PGSSLMODE: 'disable',
        MCP_TRANSPORT: 'http',
        MCP_HTTP_HOST: '127.0.0.1',
        MCP_HTTP_PORT: String(port),
        MCP_AUTH_TOKEN: token,
        MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
        MCP_ALLOWED_ORIGINS: origin,
        MCP_ENABLE_METRICS: 'true',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/readyz`);
          if (response.ok) break;
        } catch {
          // Server is still starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(unauthorized.status, 401);

      const invalidOrigin = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Origin: 'https://untrusted.example.test',
        },
        body: '{}',
      });
      assert.equal(invalidOrigin.status, 403);

      const unauthorizedMetrics = await fetch(`http://127.0.0.1:${port}/metrics`);
      assert.equal(unauthorizedMetrics.status, 401);

      const metrics = await fetch(`http://127.0.0.1:${port}/metrics`, {
        headers: { Authorization: `Bearer ${token}`, Origin: origin },
      });
      assert.equal(metrics.status, 200);
      assert.match(await metrics.text(), /postgres_mcp_health_score/);

      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
        {
          requestInit: {
            headers: { Authorization: `Bearer ${token}`, Origin: origin },
          },
        }
      );
      const client = new Client({ name: 'postgres-mcp-http-e2e', version: '1.0.0' });
      await client.connect(transport);
      const tools = await client.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === 'diagnose_query'));
      await client.close();
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once('exit', () => resolve());
      });
      assert.equal(child.exitCode, 0, stderr);
    }
  });
}
