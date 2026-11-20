/**
 * /mcp: Snaglet's external MCP server endpoint (MCP streamable HTTP), served by the
 * running Express server that owns the DB, never a second process. Mounted at
 * top-level /mcp, not under /api: /api/mcp is the MCP *client* manager for
 * servers Snaglet consumes.
 *
 * Stateless: every POST is authenticated independently (Bearer key -> member)
 * and served by a fresh Server + transport pair (sessionIdGenerator:
 * undefined), so no session state accumulates and restarts are invisible to
 * clients. enableJsonResponse keeps plain-JSON responses for plain-JSON
 * clients (curl, the snaglet-cli bridge). stdio-only clients connect through
 * `snaglet mcp` (packages/snaglet-cli), a thin stdio<->HTTP proxy to this endpoint.
 */

import { Router, type Request, type Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { mcpGatewayService, type ExternalCaller } from './McpGatewayService';
import { mcpAuthMiddleware } from './mcpAuth';

const SERVER_INFO = { name: 'snaglet', version: '1.0.0' };

/** Build a fresh MCP server wired to the gateway for one authenticated call. */
function buildMcpServer(caller: ExternalCaller): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await mcpGatewayService.listExternalTools(),
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> =>
      mcpGatewayService.executeExternalToolCall(
        request.params.name,
        (request.params.arguments ?? {}) as Record<string, unknown>,
        caller
      )
  );

  return server;
}

const router = Router();

router.use(mcpAuthMiddleware);

/**
 * enableJsonResponse means every response body here is plain JSON, but the SDK
 * transport still refuses any POST whose Accept header does not advertise both
 * application/json and text/event-stream (406 Not Acceptable), pure ceremony
 * at this endpoint that breaks curl and hand-rolled JSON-RPC clients. Callers
 * that can consume JSON (explicitly, via a wildcard, or by sending no Accept
 * header at all) get the header normalized so the transport serves them; a
 * caller that genuinely cannot accept JSON still gets the honest 406.
 */
function normalizeAcceptHeader(req: Request): void {
  const accept = req.headers.accept ?? '';
  const acceptsJson = accept === '' || /application\/json|\*\/\*/i.test(accept);
  const satisfiesSdk = accept.includes('application/json') && accept.includes('text/event-stream');
  if (!acceptsJson || satisfiesSdk) return;

  const normalized = 'application/json, text/event-stream';
  req.headers.accept = normalized;
  // The SDK's Node adapter rebuilds the web Request from req.rawHeaders (Hono
  // getRequestListener), so the parsed-header mutation above is invisible to
  // it — the raw pair must be rewritten too.
  const raw = req.rawHeaders;
  let rewritten = false;
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i]?.toLowerCase() === 'accept') {
      raw[i + 1] = normalized;
      rewritten = true;
    }
  }
  if (!rewritten) raw.push('Accept', normalized);
}

router.post('/', (req: Request, res: Response) => {
  void (async () => {
    // mcpAuthMiddleware guarantees mcpCaller; guard anyway for type safety.
    const caller = req.mcpCaller;
    if (!caller) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized.' },
        id: null,
      });
      return;
    }

    normalizeAcceptHeader(req);

    const server = buildMcpServer(caller);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — each call stands alone
      enableJsonResponse: true,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    // Global express.json has already consumed the stream — hand the parsed
    // body to the transport (the SDK-supported pre-parsed-body path).
    await transport.handleRequest(req, res, req.body);
  })().catch((err) => {
    logger.error(`[mcp] request failed: ${getErrorMessage(err)}`);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error.' },
        id: null,
      });
    }
  });
});

// Stateless mode: no server-initiated SSE stream, no sessions to terminate.
function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message: 'Method not allowed — this MCP endpoint is stateless (POST only).',
    },
    id: null,
  });
}
router.get('/', methodNotAllowed);
router.delete('/', methodNotAllowed);

export default router;
