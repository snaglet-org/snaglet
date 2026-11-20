/**
 * MCP server management API (Settings → Credentials → MCP).
 *
 * GET    /api/mcp/servers              — list servers (decorated w/ live status + credential info)
 * GET    /api/mcp/servers/:id          — single server, decorated
 * POST   /api/mcp/servers              — create/replace a server (upsert)
 * PUT    /api/mcp/servers/:id          — edit a server (upsert with id from path)
 * PATCH  /api/mcp/servers/:id/enabled  — enable/disable (global installed layer)
 * DELETE /api/mcp/servers/:id          — remove a server (undo with /restore)
 * POST   /api/mcp/servers/:id/restore  — undo a recent delete (config + agent grants)
 * POST   /api/mcp/servers/:id/test     — Test Connection (one-shot probe)
 * POST   /api/mcp/servers/:id/install  — Update: reinstall an npx server's package, restart if running
 * PUT    /api/mcp/servers/:id/credential — save the server's secret/bundle
 * DELETE /api/mcp/servers/:id/credential — remove the server's credential
 * GET    /api/mcp/servers/:id/agents — every agent and whether it may use the server
 * PUT    /api/mcp/servers/:id/agents — set exactly which agents may use it (Enable for all)
 *
 * Server *config* lives in `mcp_servers`; tools are resolved live by McpService.
 * After any mutation we reconcile McpService so the change takes effect without
 * a restart. Validation and the create/edit write rules live in
 * McpService/mcpServerConfig.ts, shared with the agent `mcp_server` tool.
 */

import { Router } from 'express';
import { McpServers } from '@snaglet/db';
import type { McpServerRow } from '@snaglet/db/tables/mcp_servers';
import { UserProviderCredentials } from '@snaglet/db/tables/user_provider_credentials';
import { mcpService } from '@server/services/McpService';
import {
  createMcpServer,
  deleteMcpServer,
  mcpCredKeyFor,
  restoreMcpServer,
  setMcpServerCredential,
  syncMcpServer,
  updateMcpServer,
} from '@server/services/McpService/mcpServerConfig';
import { providerCredentialService } from '@server/services/ProviderCredentialService';
import { agentService } from '@server/services/AgentService';
import { asyncHandler } from '@server/middleware';
import { sendCreated, sendOk } from '@server/utils/http';
import { AppError } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';

const router = Router();

const credKeyFor = mcpCredKeyFor;
const syncServer = syncMcpServer;

/** Decorate a server row with live status + credential presence for the UI. */
async function decorate(row: McpServerRow) {
  const cred = await UserProviderCredentials.findByProviderId(credKeyFor(row));
  return {
    ...row,
    status: mcpService.getStatus(row.id),
    statusDetail: mcpService.getStatusDetail(row.id),
    requiresCredential: mcpService.requiresCredential(row.id),
    credentialSpec: mcpService.getCredentialSpec(row.id),
    hasCredential: cred !== null,
    install: await mcpService.getInstallInfo(row.id),
  };
}

/**
 * Every roster agent (helpers, archived agents and the system ghost are not on
 * the roster) and whether it may use `serverId`, by name.
 */
async function serverAgents(serverId: string) {
  const agents = await agentService.list();
  return agents
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      enabled: (agent.mcpServers ?? []).includes(serverId),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

router.get(
  '/servers',
  asyncHandler(async (_req, res) => {
    await mcpService.reload();
    const rows = await McpServers.listAll();
    sendOk(res, await Promise.all(rows.map(decorate)));
  })
);

router.get(
  '/servers/:id',
  asyncHandler(async (req, res) => {
    await mcpService.reload();
    const row = await McpServers.findServer(req.params.id);
    if (!row) throw new AppError('Server not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    sendOk(res, await decorate(row));
  })
);

router.post(
  '/servers',
  asyncHandler(async (req, res) => {
    const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
    const row = await createMcpServer(req.body ?? {}, id);
    sendCreated(res, await decorate(row));
  })
);

router.put(
  '/servers/:id',
  asyncHandler(async (req, res) => {
    const existing = await McpServers.findServer(req.params.id);
    if (!existing)
      throw new AppError('Server not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    const row = await updateMcpServer(existing, req.body ?? {});
    sendOk(res, await decorate(row));
  })
);

router.patch(
  '/servers/:id/enabled',
  asyncHandler(async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') {
      throw new AppError(
        "Body must include boolean 'enabled'.",
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const row = await McpServers.setEnabled(req.params.id, req.body.enabled);
    if (!row) throw new AppError('Server not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    syncServer(row.id);
    sendOk(res, await decorate(row));
  })
);

router.delete(
  '/servers/:id',
  asyncHandler(async (req, res) => {
    const existing = await McpServers.findServer(req.params.id);
    if (!existing)
      throw new AppError('Server not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    const result = await deleteMcpServer(req.params.id, { kind: 'person' });
    if (!result) throw new AppError('Server not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    sendOk(res, result);
  })
);

/**
 * Undo a delete. The server keeps the deleted config and the agents it was on,
 * so the body is empty: secrets in `env` / `headers` never go back and forth
 * through the client. A person may restore any recent delete, including one an
 * agent made with the `mcp` tool.
 */
router.post(
  '/servers/:id/restore',
  asyncHandler(async (req, res) => {
    sendOk(res, await restoreMcpServer(req.params.id, { kind: 'person' }));
  })
);

router.post(
  '/servers/:id/test',
  asyncHandler(async (req, res) => {
    const existing = await McpServers.findServer(req.params.id);
    if (!existing)
      throw new AppError('Server not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    const result = await mcpService.testConnection(req.params.id);
    sendOk(res, result);
  })
);

/**
 * The MCP pane's Update for an `npx <pkg>` server: install the pinned
 * version (or the latest) into Snaglet's copy, then restart the server if it was
 * running. Deliberately not an op of the agent `mcp` tool: replacing the code
 * a server runs is a person's call. The result says what happened (a failed
 * install is `ok: false`, not an HTTP error) and carries the refreshed row.
 */
router.post(
  '/servers/:id/install',
  asyncHandler(async (req, res) => {
    const existing = await McpServers.findServer(req.params.id);
    if (!existing)
      throw new AppError('Server not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    const result = await mcpService.updateInstall(existing.id);
    sendOk(res, { ...result, server: await decorate(existing) });
  })
);

router.put(
  '/servers/:id/credential',
  asyncHandler(async (req, res) => {
    const server = await McpServers.findServer(req.params.id);
    if (!server) throw new AppError('Server not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    const secret = typeof req.body?.secret === 'string' ? req.body.secret : undefined;
    const bundle =
      req.body?.bundle && typeof req.body.bundle === 'object'
        ? (req.body.bundle as Record<string, string>)
        : undefined;
    await setMcpServerCredential(server, { secret, bundle });
    sendOk(res, await decorate(server));
  })
);

router.delete(
  '/servers/:id/credential',
  asyncHandler(async (req, res) => {
    const server = await McpServers.findServer(req.params.id);
    if (!server) throw new AppError('Server not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    const cred = await UserProviderCredentials.findByProviderId(credKeyFor(server));
    if (cred) await providerCredentialService.remove(cred.id);
    syncServer(server.id);
    sendOk(res, await decorate(server));
  })
);

router.get(
  '/servers/:id/agents',
  asyncHandler(async (req, res) => {
    const server = await McpServers.findServer(req.params.id);
    if (!server) throw new AppError('Server not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    sendOk(res, await serverAgents(server.id));
  })
);

/**
 * Set exactly which agents may use this server: `agentIds` is the whole new
 * set, so "Enable for all" sends every agent and Undo sends the set from
 * before. Each changed agent goes through the normal agent update, so its
 * hooks and realtime events fire as for a change in the agent's own pane.
 */
router.put(
  '/servers/:id/agents',
  asyncHandler(async (req, res) => {
    const ids: unknown = req.body?.agentIds;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      throw new AppError(
        "Body must include 'agentIds', a list of agent ids.",
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const server = await McpServers.findServer(req.params.id);
    if (!server) throw new AppError('Server not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    const agents = await agentService.list();
    const roster = new Set(agents.map((agent) => agent.id));
    const unknown = (ids as string[]).filter((id) => !roster.has(id));
    if (unknown.length > 0) {
      throw new AppError(
        `Unknown agent: ${unknown.join(', ')}`,
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const wanted = new Set(ids as string[]);
    for (const agent of agents) {
      const current = agent.mcpServers ?? [];
      const has = current.includes(server.id);
      if (has === wanted.has(agent.id)) continue;
      await agentService.update(agent.id, {
        mcpServers: has ? current.filter((id) => id !== server.id) : [...current, server.id],
      });
    }
    sendOk(res, await serverAgents(server.id));
  })
);

export default router;
