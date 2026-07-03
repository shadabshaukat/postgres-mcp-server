#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, maskConnectionUri, SERVER_NAME, SERVER_VERSION } from './config.js';
import { Database } from './database.js';
import { McpHttpServer } from './http-server.js';
import { createMcpServer } from './mcp-server.js';
import { PostgresService } from './postgres-service.js';

const main = async (): Promise<void> => {
  const config = loadConfig();
  const database = new Database(config.database);
  const service = new PostgresService(database, config);
  let httpServer: McpHttpServer | undefined;
  let stdioServer: ReturnType<typeof createMcpServer> | undefined;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[Shutdown] ${signal}`);
    await httpServer?.stop();
    await stdioServer?.close().catch(() => undefined);
    await database.close();
  };

  process.once('SIGINT', () => void shutdown('SIGINT').finally(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown('SIGTERM').finally(() => process.exit(0)));

  try {
    const identity = await database.testConnection();
    console.error(
      [
        `${SERVER_NAME}@${SERVER_VERSION}`,
        `db=${identity.database}`,
        `user=${identity.currentUser}`,
        `postgres=${identity.serverVersion}`,
        `access=${config.accessMode}`,
        `transport=${config.transportMode}`,
        `uri=${maskConnectionUri(config.database.connectionString) ?? '(PG* environment)'}`,
      ].join(' | ')
    );

    if (config.transportMode === 'http') {
      httpServer = new McpHttpServer(config.http, service, () => createMcpServer(service));
      await httpServer.start();
      return;
    }

    stdioServer = createMcpServer(service);
    await stdioServer.connect(new StdioServerTransport());
    console.error('Postgres MCP server listening on stdio');
  } catch (error) {
    await shutdown('startup failure');
    throw error;
  }
};

main().catch((error) => {
  console.error('Fatal error running Postgres MCP server:', error);
  process.exit(1);
});
