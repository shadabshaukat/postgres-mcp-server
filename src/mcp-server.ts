import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { SERVER_NAME, SERVER_VERSION } from './config.js';
import type { SqlParameter } from './database.js';
import type { ObjectType } from './postgres-service.js';
import { PostgresService } from './postgres-service.js';

const objectTypeSchema = z.enum([
  'table',
  'view',
  'materialized_view',
  'sequence',
  'function',
  'index',
  'extension',
]);

const sqlParamsSchema = z.array(z.unknown()).max(100).optional();
const looseOutputSchema = z.looseObject({});

const jsonResult = (payload: Record<string, unknown>): CallToolResult => ({
  structuredContent: payload,
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
});

const errorResult = (error: unknown): CallToolResult => {
  const message = error instanceof Error ? error.message : 'Unknown database operation failure.';
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
};

const registerTools = (server: McpServer, service: PostgresService): void => {
  server.registerTool(
    'server_info',
    {
      title: 'Postgres MCP Server Information',
      description: 'Return server safeguards, database identity, limits, and pool status.',
      outputSchema: looseOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return jsonResult(await service.serverInfo());
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'list_schemas',
    {
      title: 'List Database Schemas',
      description: 'List PostgreSQL schemas with owner and current-user privileges.',
      inputSchema: z.object({ includeSystem: z.boolean().default(false) }),
      outputSchema: looseOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ includeSystem }) => {
      try {
        return jsonResult(await service.listSchemas(includeSystem));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'list_objects',
    {
      title: 'List Database Objects',
      description:
        'List tables, views, materialized views, sequences, functions, indexes, or extensions in a schema.',
      inputSchema: z.object({ schema: z.string().min(1).max(128), objectType: objectTypeSchema }),
      outputSchema: looseOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ schema, objectType }) => {
      try {
        return jsonResult(await service.listObjects(schema, objectType as ObjectType));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'get_object_details',
    {
      title: 'Inspect Database Object',
      description: 'Return columns, constraints, indexes, statistics, or function definitions.',
      inputSchema: z.object({
        schema: z.string().min(1).max(128),
        objectName: z.string().min(1).max(128),
        objectType: objectTypeSchema,
      }),
      outputSchema: looseOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ schema, objectName, objectType }) => {
      try {
        return jsonResult(
          await service.getObjectDetails(schema, objectName, objectType as ObjectType)
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'list_extensions',
    {
      title: 'List PostgreSQL Extensions',
      description: 'List installed extensions, versions, schemas, and comments.',
      outputSchema: looseOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return jsonResult(await service.listExtensions());
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'execute_sql',
    {
      title: 'Execute PostgreSQL Statement',
      description:
        'Execute one parameterized SQL statement. Restricted mode uses a PostgreSQL READ ONLY transaction plus time, row, and response-size limits.',
      inputSchema: z.object({
        sql: z.string().min(1).max(500_000),
        params: sqlParamsSchema,
        limit: z.number().int().positive().optional(),
      }),
      outputSchema: looseOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ sql, params, limit }, extra) => {
      try {
        return jsonResult(
          await service.executeSql(
            { sql, params: params as SqlParameter[] | undefined, limit },
            extra.signal
          )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'explain_query',
    {
      title: 'Explain PostgreSQL Query',
      description:
        'Return a structured PostgreSQL JSON execution plan. ANALYZE is opt-in and always runs in a READ ONLY transaction.',
      inputSchema: z.object({
        sql: z.string().min(1).max(500_000),
        params: sqlParamsSchema,
        analyze: z.boolean().default(false),
      }),
      outputSchema: looseOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ sql, params, analyze }, extra) => {
      try {
        return jsonResult(
          await service.explainQuery(
            { sql, params: params as SqlParameter[] | undefined, analyze },
            extra.signal
          )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'diagnose_query',
    {
      title: 'Diagnose PostgreSQL Query',
      description:
        'Analyze a JSON query plan for sequential scans, estimate errors, filtering waste, disk spills, and advisory index candidates.',
      inputSchema: z.object({
        sql: z.string().min(1).max(500_000),
        params: sqlParamsSchema,
        analyze: z.boolean().default(false),
      }),
      outputSchema: looseOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ sql, params, analyze }, extra) => {
      try {
        return jsonResult(
          await service.diagnoseQuery(
            { sql, params: params as SqlParameter[] | undefined, analyze },
            extra.signal
          )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'list_slow_queries',
    {
      title: 'List Slow PostgreSQL Queries',
      description: 'Rank queries recorded by pg_stat_statements using execution and I/O metrics.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20),
        orderBy: z
          .enum(['total_exec_time', 'mean_exec_time', 'calls', 'shared_blks_read'])
          .default('total_exec_time'),
      }),
      outputSchema: looseOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit, orderBy }) => {
      try {
        return jsonResult(await service.listSlowQueries(limit, orderBy));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'database_health',
    {
      title: 'PostgreSQL Health Snapshot',
      description:
        'Return connection, cache, transaction, lock, temporary-I/O, and table-maintenance health signals.',
      outputSchema: looseOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    },
    async () => {
      try {
        return jsonResult(await service.databaseHealth());
      } catch (error) {
        return errorResult(error);
      }
    }
  );
};

const registerResources = (server: McpServer, service: PostgresService): void => {
  server.registerResource(
    'postgres-catalog',
    'postgres://catalog',
    {
      title: 'PostgreSQL Catalog',
      description: 'Database schemas and supported object categories.',
      mimeType: 'application/json',
      annotations: { audience: ['assistant', 'user'], priority: 0.9 },
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await service.catalogResource(), null, 2),
        },
      ],
    })
  );

  server.registerResource(
    'postgres-schema-objects',
    new ResourceTemplate('postgres://catalog/schema/{schema}/{objectType}', {
      list: undefined,
      complete: {
        objectType: () => [
          'table',
          'view',
          'materialized_view',
          'sequence',
          'function',
          'index',
          'extension',
        ],
      },
    }),
    {
      title: 'PostgreSQL Schema Objects',
      description: 'Objects of one category within a database schema.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const schema = String(variables.schema ?? '');
      const objectType = String(variables.objectType ?? '') as ObjectType;
      const payload = await service.listObjects(schema, objectType);
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) },
        ],
      };
    }
  );

  server.registerResource(
    'postgres-object',
    new ResourceTemplate(
      'postgres://catalog/object/{schema}/{objectType}/{objectName}',
      { list: undefined }
    ),
    {
      title: 'PostgreSQL Object Details',
      description: 'Detailed metadata for a database object.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const payload = await service.getObjectDetails(
        String(variables.schema ?? ''),
        String(variables.objectName ?? ''),
        String(variables.objectType ?? '') as ObjectType
      );
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) },
        ],
      };
    }
  );
};

export const createMcpServer = (service: PostgresService): McpServer => {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Use catalog resources for schema context, execute_sql for bounded parameterized queries, and diagnose_query for deterministic plan analysis. Index candidates are advisory and must be validated before applying.',
    }
  );
  registerTools(server, service);
  registerResources(server, service);
  server.server.onerror = (error) => console.error('[MCP Server Error]', error);
  return server;
};
