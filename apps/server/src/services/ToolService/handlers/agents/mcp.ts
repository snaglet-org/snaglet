/**
 * mcp(op) handlers — list | get | create | update | delete | restore | test |
 * set_credential for MCP servers.
 *
 * Every write goes through McpService/mcpServerConfig, the same functions the
 * Settings → MCP routes (/api/mcp/servers) use: id format, required fields per
 * transport, no overwrite on create, no collision with a provider credential
 * namespace; an edit keeps builtin provenance, the enable toggle, autoload and
 * the credential anchor unless sent; delete prunes the server from agents in
 * one transaction, and restore undoes a recent delete the same way the
 * Settings Undo does, except that an agent may restore only its own deletes.
 *
 * Secrets: list/get mask env/header values that aren't credential
 * placeholders, and no op ever echoes a credential back. Restore needs only
 * the id: the deleted config stays on the server. set_credential's input is
 * still recorded in the run transcript like any tool input.
 */
import { McpServers } from '@snaglet/db';
import type { McpServerRow } from '@snaglet/db/tables/mcp_servers';
import { getErrorMessage } from '@snaglet/shared/utils';
import { mcpService } from '@server/services/McpService';
import {
  createMcpServer,
  deleteMcpServer,
  mcpCredKeyFor,
  restoreMcpServer,
  setMcpServerCredential,
  updateMcpServer,
  type McpServerActor,
} from '@server/services/McpService/mcpServerConfig';
import { UserProviderCredentials } from '@snaglet/db/tables/user_provider_credentials';
import type { ToolHandler, ToolHandlerContext } from '@server/services/ToolService/types';

const fail = (output: string) => ({ output, rawContent: { error: output } });

const PLACEHOLDER_RE = /^\$\{(credential|cred\.[a-zA-Z0-9_]+)\}$/;

/** Mask literal values; keep `${credential}` / `${cred.x}` placeholders readable. */
export function maskValues(map: Record<string, string> | null | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(map ?? {}).map(([k, v]) => [k, PLACEHOLDER_RE.test(v) ? v : '•••'])
  );
}

async function view(row: McpServerRow) {
  const cred = await UserProviderCredentials.findByProviderId(mcpCredKeyFor(row));
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    command: row.command,
    command_args: row.args,
    url: row.url,
    env: maskValues(row.env),
    headers: maskValues(row.headers),
    scope: row.scope,
    enabled: row.enabled,
    autoload: row.autoload,
    requires_confirmation: row.requiresConfirmation,
    source: row.source,
    provider_id: row.providerId,
    status: mcpService.getStatus(row.id),
    requires_credential: mcpService.requiresCredential(row.id),
    has_credential: cred !== null,
  };
}

function isStringMap(v: unknown): v is Record<string, string> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === 'string')
  );
}

/** snake_case tool input → the route's camelCase body; type-checks what it maps. */
export function toBody(input: Record<string, unknown>): Record<string, unknown> | string {
  const body: Record<string, unknown> = {};
  for (const k of ['name', 'transport', 'command', 'url', 'scope'] as const) {
    if (input[k] === undefined) continue;
    if (typeof input[k] !== 'string') return `\`${k}\` must be a string.`;
    body[k] = input[k];
  }
  // `command_args` at the tool boundary (`args` is a reserved wrapper key).
  if (input.command_args !== undefined) {
    const a = input.command_args;
    if (!Array.isArray(a) || a.some((x) => typeof x !== 'string')) {
      return '`command_args` must be an array of strings.';
    }
    body.args = a;
  }
  for (const k of ['env', 'headers'] as const) {
    if (input[k] === undefined) continue;
    if (!isStringMap(input[k])) return `\`${k}\` must be an object of string values.`;
    body[k] = input[k];
  }
  const bools = [
    ['enabled', 'enabled'],
    ['autoload', 'autoload'],
    ['requires_confirmation', 'requiresConfirmation'],
  ] as const;
  for (const [from, to] of bools) {
    if (input[from] === undefined) continue;
    if (typeof input[from] !== 'boolean') return `\`${from}\` must be a boolean.`;
    body[to] = input[from];
  }
  if (input.provider_id !== undefined) {
    if (input.provider_id !== null && typeof input.provider_id !== 'string') {
      return '`provider_id` must be a string or null.';
    }
    body.providerId = input.provider_id;
  }
  return body;
}

/**
 * Edit = current connection spec + the fields sent; the shared rules then
 * validate the result. enabled/autoload/providerId are left out unless sent,
 * so updateMcpServer keeps the stored values.
 */
export function mergeForUpdate(
  existing: McpServerRow,
  patch: Record<string, unknown>
): Record<string, unknown> {
  return {
    name: existing.name,
    transport: existing.transport,
    command: existing.command,
    args: existing.args,
    url: existing.url,
    headers: existing.headers,
    env: existing.env,
    scope: existing.scope,
    requiresConfirmation: existing.requiresConfirmation,
    ...patch,
  };
}

/**
 * Who is calling. An agent's run (or its hook/tool child) is that agent; a
 * person running the tool from the panel, even acting as an agent, is a
 * person, as in the Settings → MCP routes.
 */
export function mcpActor(context: ToolHandlerContext | undefined): McpServerActor {
  if (context?.agentId && !context.bypassToolAccess) {
    return { kind: 'agent', agentId: context.agentId };
  }
  return { kind: 'person' };
}

function serverId(input: Record<string, unknown>): string {
  return typeof input.id === 'string' ? input.id.trim() : '';
}

async function findOrFail(id: string): Promise<McpServerRow | string> {
  if (!id) return '`id` is required.';
  const row = await McpServers.findServer(id);
  return row ?? `MCP server "${id}" not found. Use op:"list" to see servers.`;
}

export const listServers: ToolHandler = async () => {
  await mcpService.reload();
  const servers = await Promise.all((await McpServers.listAll()).map(view));
  return { output: JSON.stringify({ servers }), rawContent: { servers } };
};

export const getServer: ToolHandler = async (input) => {
  await mcpService.reload();
  const row = await findOrFail(serverId(input));
  if (typeof row === 'string') return fail(row);
  const server = await view(row);
  return { output: JSON.stringify({ server }), rawContent: { server } };
};

export const createServer: ToolHandler = async (input) => {
  const id = serverId(input);
  if (!id) return fail('`id` is required.');
  const body = toBody(input);
  if (typeof body === 'string') return fail(body);
  try {
    const row = await createMcpServer(body, id);
    return {
      output:
        `Added MCP server "${row.name}" (${row.id}, ${row.transport}). Its tools appear as ` +
        `mcp__${row.id}__<tool> once it connects. If it needs a credential, use op ` +
        'set_credential or ask a person to add it in Settings → MCP.',
      rawContent: { action: 'created', server: await view(row) },
    };
  } catch (err) {
    return fail(getErrorMessage(err));
  }
};

export const updateServer: ToolHandler = async (input) => {
  const existing = await findOrFail(serverId(input));
  if (typeof existing === 'string') return fail(existing);
  const body = toBody(input);
  if (typeof body === 'string') return fail(body);
  if (Object.keys(body).length === 0) return fail('Nothing to update: pass at least one field.');
  try {
    const row = await updateMcpServer(existing, mergeForUpdate(existing, body));
    return {
      output: `Updated MCP server "${row.name}" (${row.id}): ${Object.keys(body).join(', ')}. It reconnects with the new config.`,
      rawContent: { action: 'updated', server: await view(row) },
    };
  } catch (err) {
    return fail(getErrorMessage(err));
  }
};

export const deleteServer: ToolHandler = async (input, _settings, context) => {
  const existing = await findOrFail(serverId(input));
  if (typeof existing === 'string') return fail(existing);
  try {
    const result = await deleteMcpServer(existing.id, mcpActor(context));
    if (!result) return fail(`MCP server "${existing.id}" not found.`);
    return {
      output:
        `Deleted MCP server "${existing.name}" (${existing.id}) and removed it from ` +
        `${result.agentsPruned} agent(s). Its saved credential, if any, is kept. ` +
        'op restore undoes this for 10 minutes.',
      rawContent: { action: 'deleted', ...result },
    };
  } catch (err) {
    return fail(getErrorMessage(err));
  }
};

export const restoreServer: ToolHandler = async (input, _settings, context) => {
  const id = serverId(input);
  if (!id) return fail('`id` is required.');
  try {
    const result = await restoreMcpServer(id, mcpActor(context));
    return {
      output:
        `Restored MCP server "${id}" as it was before the delete and turned it back on ` +
        `for ${result.agentsRestored} agent(s).`,
      rawContent: { action: 'restored', ...result },
    };
  } catch (err) {
    return fail(getErrorMessage(err));
  }
};

export const testServer: ToolHandler = async (input) => {
  const existing = await findOrFail(serverId(input));
  if (typeof existing === 'string') return fail(existing);
  const result = await mcpService.testConnection(existing.id);
  const output = result.ok
    ? `MCP server "${existing.id}" connected: ${result.toolCount} tool(s).`
    : `MCP server "${existing.id}" did not connect (${result.status}): ${result.error ?? 'unknown error'}`;
  return { output, rawContent: result };
};

export const setServerCredential: ToolHandler = async (input) => {
  const existing = await findOrFail(serverId(input));
  if (typeof existing === 'string') return fail(existing);
  const secret = input.secret;
  const bundle = input.bundle;
  if (secret !== undefined && (typeof secret !== 'string' || !secret)) {
    return fail('`secret` must be a non-empty string.');
  }
  if (bundle !== undefined && !isStringMap(bundle)) {
    return fail('`bundle` must be an object of string values.');
  }
  try {
    await setMcpServerCredential(existing, {
      secret: secret as string | undefined,
      bundle: bundle as Record<string, string> | undefined,
    });
  } catch (err) {
    return fail(getErrorMessage(err));
  }
  // Never echo the secret or bundle values back.
  const saved = [
    ...(secret !== undefined ? ['secret'] : []),
    ...(bundle !== undefined ? [`bundle (${Object.keys(bundle as object).join(', ')})`] : []),
  ];
  return {
    output: `Saved the credential for MCP server "${existing.id}": ${saved.join(' and ')}. It reconnects now.`,
    rawContent: { action: 'credential_saved', id: existing.id, saved },
  };
};
