import { randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { URL } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { HttpConfig } from './config.js';
import type { PostgresService } from './postgres-service.js';

interface StreamableSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
}

interface LegacySession {
  server: McpServer;
  transport: SSEServerTransport;
  lastSeenAt: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const sessionHeader = (req: http.IncomingMessage): string | undefined => {
  const value = req.headers['mcp-session-id'];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value) && value[0]?.trim()) return value[0].trim();
  return undefined;
};

const secureEquals = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const hostnameFromHeader = (hostHeader: string): string | undefined => {
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

export class McpHttpServer {
  private server?: http.Server;
  private cleanupTimer?: NodeJS.Timeout;
  private readonly streamableSessions = new Map<string, StreamableSession>();
  private readonly legacySessions = new Map<string, LegacySession>();

  constructor(
    private readonly config: HttpConfig,
    private readonly service: PostgresService,
    private readonly createServer: () => McpServer
  ) {}

  get activeSessionCount(): number {
    return this.streamableSessions.size + this.legacySessions.size;
  }

  private sendJson(
    res: http.ServerResponse,
    status: number,
    payload: Record<string, unknown>,
    headers: Record<string, string> = {}
  ): void {
    if (res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(payload));
  }

  private sendText(
    res: http.ServerResponse,
    status: number,
    payload: string,
    contentType: string
  ): void {
    if (res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    res.end(payload);
  }

  private validateSecurity(req: http.IncomingMessage): void {
    const hostHeader = req.headers.host;
    const hostname = hostHeader ? hostnameFromHeader(hostHeader) : undefined;
    const rawAllowedHosts = new Set(this.config.allowedHosts.map((host) => host.toLowerCase()));
    const hostAllowed =
      !!hostHeader &&
      !!hostname &&
      (rawAllowedHosts.has(hostHeader.toLowerCase()) || rawAllowedHosts.has(hostname));
    if (!hostAllowed && !this.config.allowInsecure) {
      throw new HttpError(403, 'Host header is not allowed.');
    }

    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (origin && !this.config.allowedOrigins.includes(origin) && !this.config.allowInsecure) {
      throw new HttpError(403, 'Origin is not allowed.');
    }

    if (this.config.authToken) {
      const authorization = req.headers.authorization ?? '';
      const prefix = 'Bearer ';
      if (!authorization.startsWith(prefix)) throw new HttpError(401, 'Bearer token is required.');
      const supplied = authorization.slice(prefix.length).trim();
      if (!secureEquals(supplied, this.config.authToken)) {
        throw new HttpError(401, 'Bearer token is invalid.');
      }
    }
  }

  private async parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > this.config.maxBodyBytes) {
        throw new HttpError(413, `Request body exceeds ${this.config.maxBodyBytes} bytes.`);
      }
      chunks.push(buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'Request body must be valid JSON.');
    }
  }

  private async closeStreamableSession(sessionId: string): Promise<void> {
    const session = this.streamableSessions.get(sessionId);
    if (!session) return;
    this.streamableSessions.delete(sessionId);
    await session.server.close().catch((error) =>
      console.error(`[Session Cleanup Error] ${sessionId}`, error)
    );
  }

  private async closeLegacySession(sessionId: string): Promise<void> {
    const session = this.legacySessions.get(sessionId);
    if (!session) return;
    this.legacySessions.delete(sessionId);
    await session.server.close().catch((error) =>
      console.error(`[Legacy Session Cleanup Error] ${sessionId}`, error)
    );
  }

  private async sweepExpiredSessions(): Promise<void> {
    const cutoff = Date.now() - this.config.sessionTtlMs;
    const streamable = [...this.streamableSessions.entries()]
      .filter(([, session]) => session.lastSeenAt < cutoff)
      .map(([sessionId]) => this.closeStreamableSession(sessionId));
    const legacy = [...this.legacySessions.entries()]
      .filter(([, session]) => session.lastSeenAt < cutoff)
      .map(([sessionId]) => this.closeLegacySession(sessionId));
    await Promise.allSettled([...streamable, ...legacy]);
  }

  private async handleStreamable(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body?: unknown
  ): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const sessionId = sessionHeader(req);

    if (sessionId) {
      const session = this.streamableSessions.get(sessionId);
      if (!session) {
        this.sendJson(res, 404, { error: `Unknown or expired MCP session: ${sessionId}` });
        return;
      }
      session.lastSeenAt = Date.now();
      await session.transport.handleRequest(req, res, body);
      return;
    }

    if (method !== 'POST' || !isInitializeRequest(body)) {
      this.sendJson(res, 400, { error: 'Start a session with an MCP initialize POST request.' });
      return;
    }
    if (this.streamableSessions.size >= this.config.maxSessions) {
      this.sendJson(res, 503, { error: 'The MCP session capacity has been reached.' });
      return;
    }

    const mcpServer = this.createServer();
    let transport: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (newSessionId) => {
        this.streamableSessions.set(newSessionId, {
          server: mcpServer,
          transport,
          lastSeenAt: Date.now(),
        });
      },
      onsessionclosed: (closedSessionId) => {
        this.streamableSessions.delete(closedSessionId);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) this.streamableSessions.delete(transport.sessionId);
    };
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  private async handleLegacy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    body?: unknown
  ): Promise<void> {
    if (!this.config.legacySseEnabled) {
      this.sendJson(res, 410, { error: 'Legacy SSE is disabled. Use the Streamable HTTP endpoint.' });
      return;
    }

    const method = (req.method ?? 'GET').toUpperCase();
    if (url.pathname === this.config.legacySsePath) {
      if (method !== 'GET') throw new HttpError(405, 'Legacy SSE endpoint accepts GET only.');
      if (this.legacySessions.size >= this.config.maxSessions) {
        throw new HttpError(503, 'The MCP session capacity has been reached.');
      }
      const transport = new SSEServerTransport(this.config.legacyMessagesPath, res, {
        // Host and Origin are validated once by validateSecurity before transport routing.
        enableDnsRebindingProtection: false,
      });
      const mcpServer = this.createServer();
      const id = transport.sessionId;
      transport.onclose = () => this.legacySessions.delete(id);
      this.legacySessions.set(id, { server: mcpServer, transport, lastSeenAt: Date.now() });
      await mcpServer.connect(transport);
      return;
    }

    if (url.pathname === this.config.legacyMessagesPath) {
      if (method !== 'POST') throw new HttpError(405, 'Legacy message endpoint accepts POST only.');
      const id = url.searchParams.get('sessionId') ?? '';
      const session = this.legacySessions.get(id);
      if (!session) throw new HttpError(404, 'Unknown or expired legacy MCP session.');
      session.lastSeenAt = Date.now();
      await session.transport.handlePostMessage(req, res, body);
      return;
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/healthz') {
      this.sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (url.pathname === '/readyz') {
      try {
        await this.service.serverInfo();
        this.sendJson(res, 200, { status: 'ready' });
      } catch {
        this.sendJson(res, 503, { status: 'not_ready' });
      }
      return;
    }

    this.validateSecurity(req);
    const method = (req.method ?? 'GET').toUpperCase();
    if (this.config.metricsEnabled && url.pathname === this.config.metricsPath) {
      if (method !== 'GET') throw new HttpError(405, 'Metrics endpoint accepts GET only.');
      this.sendText(
        res,
        200,
        await this.service.prometheusMetrics(),
        'text/plain; version=0.0.4; charset=utf-8'
      );
      return;
    }
    const body = method === 'POST' ? await this.parseJsonBody(req) : undefined;

    if (
      url.pathname === this.config.legacySsePath ||
      url.pathname === this.config.legacyMessagesPath
    ) {
      await this.handleLegacy(req, res, url, body);
      return;
    }
    if (url.pathname !== this.config.path) {
      throw new HttpError(404, `Not found. MCP endpoint: ${this.config.path}`);
    }
    await this.handleStreamable(req, res, body);
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch((error) => {
        const status = error instanceof HttpError ? error.status : 500;
        const message = error instanceof Error ? error.message : 'Unknown HTTP error.';
        if (status >= 500) console.error(`[MCP HTTP Error] ${req.method} ${req.url}`, error);
        const headers: Record<string, string> =
          status === 401 ? { 'WWW-Authenticate': 'Bearer realm="postgres-mcp"' } : {};
        this.sendJson(res, status, { error: message }, headers);
      });
    });
    this.server.requestTimeout = this.config.requestTimeoutMs;
    this.server.headersTimeout = 15_000;
    this.server.keepAliveTimeout = 5_000;
    this.server.maxRequestsPerSocket = 1_000;

    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      server.once('error', reject);
      server.listen(this.config.port, this.config.host, () => {
        server.off('error', reject);
        resolve();
      });
    });

    const sweepEvery = Math.min(Math.max(5_000, Math.floor(this.config.sessionTtlMs / 2)), 60_000);
    this.cleanupTimer = setInterval(() => void this.sweepExpiredSessions(), sweepEvery);
    this.cleanupTimer.unref();
    console.error(
      `Postgres MCP server listening at http://${this.config.host}:${this.config.port}${this.config.path}`
    );
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await Promise.allSettled([
      ...[...this.streamableSessions.keys()].map((id) => this.closeStreamableSession(id)),
      ...[...this.legacySessions.keys()].map((id) => this.closeLegacySession(id)),
    ]);
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      this.server = undefined;
    }
  }
}
