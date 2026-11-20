import { Router } from 'express';
import { asyncHandler } from '@server/middleware';
import { sendOk, sendCreated } from '@server/utils/http';
import { Tools } from '@snaglet/db/tables/tools';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import { logger } from '@server/config/logger';
import { mcpService } from '@server/services/McpService';
import { mcpToolDefToToolRow } from '@server/services/McpService/mcpToolRow';
import { canonicalToolRows } from '@server/services/ToolService/lib/canonicalToolRows';
import { decorateToolRow } from './helpers';

const router = Router();

// GET /api/tools — list all tools (optionally filter by active)
//
// Native builtin (and external) tools are persisted `tools` rows and always
// listed here. Live MCP tools are not persisted (discovered live per server),
// so they are absent by default: the sidebar / single-tool admin surfaces
// only manage persisted rows (per-tool enable/disable). The tool-access
// settings pane sets `?includeMcp=true` to also list every enabled MCP
// server's live tools, so agents' native + MCP tools appear in one grouped
// list (MCP tools group under `integrations/<serverId>`, their availability is
// per-server, never a persisted `enabled` flag).
//
// Every list is canonical: alias ids (`exec_command`, `get_node`) stay
// callable, but the rows still stored under them are never offered (see
// canonicalToolRows).
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const activeOnly = req.query.active === 'true';
    const includeMcp = req.query.includeMcp === 'true';
    const persisted = canonicalToolRows(
      activeOnly ? await Tools.listResolvable() : await Tools.listAll()
    );
    // Two read-time decorations per row: credential/provider availability, then
    // static execution metadata (contextRequirement / destructive /
    // dispatchOnly from definition.ts) that drives the panel's act-as picker,
    // confirm gate, and hidden-Run state. MCP tools below get neither — no
    // definition.ts, treated as standalone/non-destructive.
    const decorated = await Promise.all(persisted.map(decorateToolRow));
    if (!includeMcp) {
      sendOk(res, decorated);
      return;
    }
    // MCP tools are gated per-server, not by a persisted `enabled` flag, so they
    // don't pass through the credential-based availability gate — a listed one
    // is available by construction (its server is enabled and warm).
    const mcpTools = mcpService
      .getCatalogToolDefs()
      .map((def) => ({ ...mcpToolDefToToolRow(def), availability: 'available' as const }));
    sendOk(res, [...decorated, ...mcpTools]);
  })
);

// POST /api/tools — create a new custom tool
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const tool = await Tools.create(req.body);
    sendCreated(res, tool);
  })
);

// POST /api/tools/reload — force the running server to re-scan tool folders
// and rebuild its in-memory handler map. Lets tools added to disk after boot
// become callable WITHOUT a server restart. Registered before any /:id route
// so 'reload' is never parsed as a tool id.
router.post(
  '/reload',
  asyncHandler(async (_req, res) => {
    const result = await toolRegistry.reload();
    logger.info(`[tools.routes] tool registry reloaded — ${result.count} tools registered`);
    sendOk(res, { reloaded: true, count: result.count });
  })
);

export default router;
