/**
 * mcpServerConfig — validation and write rules for an `mcp_servers` row,
 * shared by the MCP settings routes (routes/mcp.ts) and the agent-facing
 * `mcp_server` tool, so both apply the same id, transport and credential
 * namespace rules.
 *
 * Throws AppError (VALIDATION_ERROR / CONFLICT); the route turns those into
 * HTTP errors and the tool turns them into a tool error message.
 */
import { McpServers } from '@snaglet/db';
import type {
  McpServerRow,
  McpTransport,
  UpsertMcpServerInput,
} from '@snaglet/db/tables/mcp_servers';
import { Providers } from '@snaglet/db/tables/providers';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { AppError, getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { emitAgentUpdated } from '@server/realtime/surfaces/agents';
import { providerCredentialService } from '@server/services/ProviderCredentialService';
import { normalizeProviderId } from '@server/services/ProviderCredentialService/normalization';
import { mcpService } from '@server/services/McpService';

const MCP_SERVER_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const MCP_TRANSPORTS: McpTransport[] = ['stdio', 'http', 'sse'];

/** The provider-credential key a server's credentials are stored under. */
export function mcpCredKeyFor(row: Pick<McpServerRow, 'id' | 'providerId'>): string {
  return row.providerId ?? row.id;
}

function invalid(message: string): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
}

/** Validate + normalize an upsert body into UpsertMcpServerInput. */
function parseMcpServerUpsert(body: Record<string, unknown>, id: string): UpsertMcpServerInput {
  if (!MCP_SERVER_ID_RE.test(id)) {
    throw invalid(`Invalid server id '${id}' (use lowercase letters, digits, '-' or '_').`);
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw invalid("Missing required field 'name'.");
  const transport = (body.transport as McpTransport) ?? 'stdio';
  if (!MCP_TRANSPORTS.includes(transport)) {
    throw invalid(`Invalid transport '${transport}' (expected stdio | http | sse).`);
  }
  if (transport === 'stdio' && !body.command) {
    throw invalid("stdio servers require a 'command'.");
  }
  if ((transport === 'http' || transport === 'sse') && !body.url) {
    throw invalid(`${transport} servers require a 'url'.`);
  }
  return {
    id,
    name,
    transport,
    providerId: (body.providerId as string | null) ?? null,
    command: (body.command as string | null) ?? null,
    args: Array.isArray(body.args) ? (body.args as string[]) : [],
    url: (body.url as string | null) ?? null,
    headers: (body.headers as Record<string, string>) ?? {},
    env: (body.env as Record<string, string>) ?? {},
    scope: body.scope === 'per-agent' ? 'per-agent' : 'shared',
    enabled: body.enabled === undefined ? true : Boolean(body.enabled),
    autoload: Boolean(body.autoload),
    requiresConfirmation:
      body.requiresConfirmation === undefined ? true : Boolean(body.requiresConfirmation),
    source: 'user',
  };
}

/**
 * Reject a server whose id would collide with an existing provider's credential
 * namespace (m1). A server with no explicit `providerId` anchors its credential
 * by its own id (`credentialKey = providerId ?? id`), run through
 * `normalizeProviderId` — so id `openai` (or `gemini` → `google`) would read/write
 * that provider's real credential. Servers explicitly anchored to a provider are
 * intentional and skipped.
 */
async function assertNoMcpProviderCollision(input: UpsertMcpServerInput): Promise<void> {
  if (input.providerId) return;
  const key = normalizeProviderId(input.id);
  const clash = await Providers.findById(key);
  if (clash) {
    throw new AppError(
      `Server id '${input.id}' collides with the '${clash.id}' provider's credential namespace — its credentials would be shared or overwritten. Choose a different id.`,
      ErrorCode.CONFLICT,
      HTTP_STATUS.CONFLICT
    );
  }
}

/** Fire-and-forget reconcile so a config change takes effect without restart. */
export function syncMcpServer(serverId: string): void {
  mcpService.syncFromProvider(serverId).catch((err: unknown) => {
    logger.warn(`[mcp] sync failed for ${serverId}: ${getErrorMessage(err)}`);
  });
}

/**
 * Create a server. Refuses an existing id: upsertServer is ON CONFLICT DO
 * UPDATE, so without this a create could clobber a builtin (e.g. the seeded
 * notion/github servers).
 */
export async function createMcpServer(
  body: Record<string, unknown>,
  id: string
): Promise<McpServerRow> {
  const input = parseMcpServerUpsert(body, id);
  if (await McpServers.findServer(id)) {
    throw new AppError(
      `Server '${id}' already exists — edit it instead of re-creating.`,
      ErrorCode.CONFLICT,
      HTTP_STATUS.CONFLICT
    );
  }
  await assertNoMcpProviderCollision(input);
  const row = await McpServers.upsertServer(input);
  syncMcpServer(row.id);
  return row;
}

/**
 * Edit an existing server. upsertServer overwrites every column, but the
 * config form only manages the connection spec. Preserve fields the body
 * doesn't send so an edit can't silently flip them: builtin provenance,
 * the enable toggle (own endpoint; a missing `enabled` must not default to
 * true and re-expose e.g. postgres), autoload, and the credential anchor
 * (`providerId`).
 */
export async function updateMcpServer(
  existing: McpServerRow,
  body: Record<string, unknown>
): Promise<McpServerRow> {
  const input = parseMcpServerUpsert(body, existing.id);
  if (existing.source === 'builtin') input.source = 'builtin';
  if (body.enabled === undefined) input.enabled = existing.enabled;
  if (body.autoload === undefined) input.autoload = existing.autoload;
  if (body.providerId === undefined) input.providerId = existing.providerId;
  await assertNoMcpProviderCollision(input);
  const row = await McpServers.upsertServer(input);
  syncMcpServer(row.id);
  return row;
}

/**
 * How long a deleted server stays restorable. The client's Undo toast is the
 * user-facing window (the app's standard action-toast duration), but that
 * toast pauses while hovered or focused, so the server keeps the snapshot
 * well past it. An npx server's installed package stays on disk for the same
 * window, so a restore starts from it without reinstalling.
 */
export const MCP_SERVER_UNDO_WINDOW_MS = 10 * 60_000;

/**
 * Who deletes or restores a server. A person (Settings → MCP, the REST
 * routes) may restore any recent delete; an agent only the ones it made.
 */
export type McpServerActor = { kind: 'person' } | { kind: 'agent'; agentId: string };

interface DeletedMcpServer {
  server: McpServerRow;
  agentIds: string[];
  deletedBy: McpServerActor;
  timer: NodeJS.Timeout;
}

/**
 * Snapshots of recently deleted servers, by id. Held in server memory only:
 * the config can carry secrets in `env` and `headers`, so undo never sends it
 * through the client and a restore needs nothing but the id. Lost on restart.
 */
const deletedServers = new Map<string, DeletedMcpServer>();

function forgetDeletedServer(id: string): void {
  const entry = deletedServers.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  deletedServers.delete(id);
}

function rememberDeletedServer(
  server: McpServerRow,
  agentIds: string[],
  deletedBy: McpServerActor
): void {
  forgetDeletedServer(server.id);
  const timer = setTimeout(() => {
    deletedServers.delete(server.id);
    void mcpService.removeInstall(server.id);
  }, MCP_SERVER_UNDO_WINDOW_MS);
  timer.unref();
  deletedServers.set(server.id, { server, agentIds, deletedBy, timer });
}

function isSameActor(a: McpServerActor, b: McpServerActor): boolean {
  if (a.kind === 'agent' && b.kind === 'agent') return a.agentId === b.agentId;
  return a.kind === b.kind;
}

/**
 * The prune and the regrant write agent rows directly (one transaction with
 * the server row), not through agentService.update, so they announce the
 * change themselves.
 */
function announceMcpServersChanged(agentIds: readonly string[]): void {
  for (const agentId of agentIds) emitAgentUpdated(agentId, ['mcpServers']);
}

/**
 * Delete a server. Delete + agent prune are one transaction: no agent may keep
 * a dangling mcp_servers reference to a deleted server.
 * Returns null when there is no such server. Each pruned agent gets an
 * `agent.updated` event, so open agent panes drop the server. The deleted
 * config and the agents it was on stay restorable for
 * MCP_SERVER_UNDO_WINDOW_MS (restoreMcpServer), along with who deleted it.
 * The saved credential is never touched, so it is still there on restore;
 * the install folder of an npx server goes only when that window ends.
 */
export async function deleteMcpServer(
  id: string,
  deletedBy: McpServerActor
): Promise<{ id: string; removed: true; agentsPruned: number } | null> {
  const removal = await McpServers.removeAndPruneAgents(id);
  if (!removal.removed) return null;
  rememberDeletedServer(removal.server, removal.prunedAgentIds, deletedBy);
  announceMcpServersChanged(removal.prunedAgentIds);
  await mcpService.disconnect(id);
  await mcpService.reload();
  return { id, removed: true, agentsPruned: removal.agentsPruned };
}

/**
 * Undo a recent delete: put the server back with its exact config and turn it
 * back on for the agents that had it (agents deleted since are skipped), each
 * of which gets an `agent.updated` event.
 * NOT_FOUND once the undo window has passed; FORBIDDEN when an agent asks to
 * restore a delete it did not make; CONFLICT when a server with the same id
 * was created in the meantime.
 */
export async function restoreMcpServer(
  id: string,
  restoredBy: McpServerActor
): Promise<{ id: string; restored: true; agentsRestored: number }> {
  const entry = deletedServers.get(id);
  if (!entry) {
    throw new AppError(
      `Server '${id}' can no longer be restored: its undo window has passed.`,
      ErrorCode.NOT_FOUND,
      HTTP_STATUS.NOT_FOUND
    );
  }
  if (restoredBy.kind === 'agent' && !isSameActor(entry.deletedBy, restoredBy)) {
    throw new AppError(
      `Server '${id}' was deleted by someone else, so you can't restore it: an agent can ` +
        'restore only a server it deleted itself.',
      ErrorCode.FORBIDDEN,
      HTTP_STATUS.FORBIDDEN
    );
  }
  const { restored, agentsRestored, restoredAgentIds } = await McpServers.restoreAndRegrantAgents(
    entry.server,
    entry.agentIds
  );
  if (!restored) {
    throw new AppError(
      `Server '${id}' can't be restored: a server with that id exists again.`,
      ErrorCode.CONFLICT,
      HTTP_STATUS.CONFLICT
    );
  }
  forgetDeletedServer(id);
  announceMcpServersChanged(restoredAgentIds);
  syncMcpServer(id);
  return { id, restored: true, agentsRestored };
}

/**
 * Save a server's credential: an opaque `secret` and/or a field `bundle`,
 * stored under the server's credential key (providerId ?? id), then reconnect.
 */
export async function setMcpServerCredential(
  server: McpServerRow,
  input: { secret?: string; bundle?: Record<string, string> }
): Promise<void> {
  const { secret, bundle } = input;
  if (secret === undefined && bundle === undefined) {
    throw invalid("Provide a 'secret' string or a 'bundle' object.");
  }
  const providerId = mcpCredKeyFor(server);
  if (bundle !== undefined) {
    await providerCredentialService.saveBundle({ providerId, bundle, label: server.name });
  }
  if (secret !== undefined) {
    await providerCredentialService.upsertSecret({ providerId, secret, label: server.name });
  }
  syncMcpServer(server.id);
}
