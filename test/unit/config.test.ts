import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../../src/config.js';

const argv = ['node', 'server.js'];

test('uses fail-closed local defaults', () => {
  const config = loadConfig({}, argv, () => false);
  assert.equal(config.accessMode, 'restricted');
  assert.equal(config.transportMode, 'stdio');
  assert.equal(config.http.host, '127.0.0.1');
  assert.equal(config.database.sslFallbackToDisable, false);
  assert.equal(config.allowExplainAnalyze, false);
});

test('requires authentication and allowed hosts for remote HTTP', () => {
  assert.throws(
    () =>
      loadConfig(
        { MCP_TRANSPORT: 'http', MCP_HTTP_HOST: '0.0.0.0' },
        argv,
        () => false
      ),
    /MCP_AUTH_TOKEN is required/
  );
  assert.throws(
    () =>
      loadConfig(
        {
          MCP_TRANSPORT: 'http',
          MCP_HTTP_HOST: '0.0.0.0',
          MCP_AUTH_TOKEN: 'a-secure-test-token',
        },
        argv,
        () => false
      ),
    /MCP_ALLOWED_HOSTS is required/
  );
});

test('accepts an authenticated remote HTTP configuration', () => {
  const config = loadConfig(
    {
      MCP_TRANSPORT: 'http',
      MCP_HTTP_HOST: '0.0.0.0',
      MCP_AUTH_TOKEN: 'a-secure-test-token',
      MCP_ALLOWED_HOSTS: 'db-mcp.example.test,127.0.0.1',
      MCP_ALLOWED_ORIGINS: 'https://app.example.test',
    },
    argv,
    () => false
  );
  assert.equal(config.transportMode, 'http');
  assert.deepEqual(config.http.allowedHosts, ['db-mcp.example.test', '127.0.0.1']);
  assert.deepEqual(config.http.allowedOrigins, ['https://app.example.test']);
});

test('rejects malformed limits and booleans', () => {
  assert.throws(() => loadConfig({ MCP_MAX_ROWS: '0' }, argv, () => false), /MCP_MAX_ROWS/);
  assert.throws(
    () => loadConfig({ MCP_ALLOW_EXPLAIN_ANALYZE: 'sometimes' }, argv, () => false),
    /Invalid boolean/
  );
  assert.throws(
    () => loadConfig({ MCP_AUTH_TOKEN: 'short' }, argv, () => false),
    /at least 16 characters/
  );
});

test('maps localhost to the Podman/Docker host alias inside a container', () => {
  const config = loadConfig(
    { DATABASE_URI: 'postgres://user:pass@localhost:5432/app' },
    argv,
    (path) => path === '/run/.containerenv'
  );
  assert.match(config.database.connectionString ?? '', /host\.containers\.internal/);
});
