/**
 * McpServerModel — Model class for the mcp_servers table.
 *
 * The connection spec for an MCP server (DB-driven config; `.mcp.json` is only a
 * seed/import). Tools are resolved live from the running server at turn time and
 * are never persisted here. `provider_id` anchors credentials in
 * `user_provider_credentials`; NULL for servers that need no credential.
 */

import { Model } from '@snaglet/db/Model';
import { transaction } from '@snaglet/db/db';
import { Agents } from '../agents';

export type McpTransport = 'stdio' | 'http' | 'sse';
export type McpScope = 'shared' | 'per-agent';
export type McpSource = 'builtin' | 'user';

/** Row shape (base Model maps snake_case → camelCase and parses jsonb). */
export interface McpServerRow {
  id: string;
  providerId: string | null;
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  url: string | null;
  headers: Record<string, string>;
  env: Record<string, string>;
  scope: McpScope;
  enabled: boolean;
  autoload: boolean;
  requiresConfirmation: boolean;
  source: McpSource;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertMcpServerInput {
  id: string;
  providerId?: string | null;
  name: string;
  transport?: McpTransport;
  command?: string | null;
  args?: string[];
  url?: string | null;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  scope?: McpScope;
  enabled?: boolean;
  autoload?: boolean;
  requiresConfirmation?: boolean;
  source?: McpSource;
}

class McpServerModelClass extends Model<McpServerRow> {
  constructor() {
    super({
      table: 'mcp_servers',
      primaryKey: 'id',
    });
  }

  /** All servers ordered by name. */
  async listAll(): Promise<McpServerRow[]> {
    return this.query<McpServerRow>(`SELECT * FROM mcp_servers ORDER BY name`);
  }

  /** Servers the operator has installed/connectable (the global layer). */
  async listEnabled(): Promise<McpServerRow[]> {
    return this.query<McpServerRow>(`SELECT * FROM mcp_servers WHERE enabled = TRUE ORDER BY name`);
  }

  /** Find a single server by id. */
  async findServer(id: string): Promise<McpServerRow | null> {
    return this.findById(id);
  }

  /** Create or replace a server row (used by the UI add/edit + import). */
  async upsertServer(input: UpsertMcpServerInput): Promise<McpServerRow> {
    const row = await this.queryOne<McpServerRow>(
      `INSERT INTO mcp_servers
         (id, provider_id, name, transport, command, args, url, headers, env,
          scope, enabled, autoload, requires_confirmation, source, updated_at)
       VALUES
         ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::jsonb,
          $10, $11, $12, $13, $14, NOW())
       ON CONFLICT (id) DO UPDATE SET
         provider_id = EXCLUDED.provider_id,
         name = EXCLUDED.name,
         transport = EXCLUDED.transport,
         command = EXCLUDED.command,
         args = EXCLUDED.args,
         url = EXCLUDED.url,
         headers = EXCLUDED.headers,
         env = EXCLUDED.env,
         scope = EXCLUDED.scope,
         enabled = EXCLUDED.enabled,
         autoload = EXCLUDED.autoload,
         requires_confirmation = EXCLUDED.requires_confirmation,
         source = EXCLUDED.source,
         updated_at = NOW()
       RETURNING *`,
      [
        input.id,
        input.providerId ?? null,
        input.name,
        input.transport ?? 'stdio',
        input.command ?? null,
        JSON.stringify(input.args ?? []),
        input.url ?? null,
        JSON.stringify(input.headers ?? {}),
        JSON.stringify(input.env ?? {}),
        input.scope ?? 'shared',
        input.enabled ?? true,
        input.autoload ?? false,
        // Safe default: a server whose policy is unspecified asks before
        // each tool call. The route sets this explicitly; this guards any other
        // caller. Seeded builtins set their own value via SQL.
        input.requiresConfirmation ?? true,
        input.source ?? 'user',
      ]
    );
    if (!row) throw new Error(`Failed to upsert mcp_server: ${input.id}`);
    return row;
  }

  /** Toggle the installed/connectable flag. */
  async setEnabled(id: string, enabled: boolean): Promise<McpServerRow | null> {
    return this.queryOne<McpServerRow>(
      `UPDATE mcp_servers SET enabled = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, enabled]
    );
  }

  /**
   * Remove a server and strip its id from every agent's `mcp_servers` array in
   * one transaction: the server must never be gone while agents still point
   * at it, and a failed prune must roll the delete back. `removed: false`
   * means the row was already gone (a raced or repeated delete); the route
   * surfaces that as its usual 404 and no agent row is touched. This is the
   * only delete path; a bare row delete would silently skip the prune.
   * (The server's provider/credential, if any, is managed separately.)
   *
   * A removal returns the deleted row and the pruned agent ids, which is
   * everything `restoreAndRegrantAgents` needs to undo it.
   */
  async removeAndPruneAgents(id: string): Promise<McpServerRemoval> {
    return transaction(async (tx) => {
      const del = await tx.query(`DELETE FROM mcp_servers WHERE id = $1 RETURNING *`, [id]);
      const server = this.transformRow<McpServerRow>(del.rows[0]);
      if (!server) return { removed: false, agentsPruned: 0 };
      const prunedAgentIds = await Agents.pruneMcpServerId(id, tx);
      return { removed: true, agentsPruned: prunedAgentIds.length, server, prunedAgentIds };
    });
  }

  /**
   * Undo `removeAndPruneAgents`: put the deleted row back exactly (same id,
   * config and created_at) and re-add its id to the agents it was pruned
   * from, in one transaction. `restored: false` means a server with that id
   * exists again, and nothing is written. `restoredAgentIds` are the agents
   * that got the id back.
   */
  async restoreAndRegrantAgents(
    server: McpServerRow,
    agentIds: readonly string[]
  ): Promise<{ restored: boolean; agentsRestored: number; restoredAgentIds: string[] }> {
    return transaction(async (tx) => {
      const ins = await tx.query(
        `INSERT INTO mcp_servers
           (id, provider_id, name, transport, command, args, url, headers, env,
            scope, enabled, autoload, requires_confirmation, source, created_at, updated_at)
         VALUES
           ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::jsonb,
            $10, $11, $12, $13, $14, $15, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [
          server.id,
          server.providerId,
          server.name,
          server.transport,
          server.command,
          JSON.stringify(server.args),
          server.url,
          JSON.stringify(server.headers),
          JSON.stringify(server.env),
          server.scope,
          server.enabled,
          server.autoload,
          server.requiresConfirmation,
          server.source,
          server.createdAt,
        ]
      );
      if ((ins.rowCount ?? 0) === 0) {
        return { restored: false, agentsRestored: 0, restoredAgentIds: [] };
      }
      const restoredAgentIds = await Agents.grantMcpServerId(server.id, agentIds, tx);
      return { restored: true, agentsRestored: restoredAgentIds.length, restoredAgentIds };
    });
  }
}

/** What `removeAndPruneAgents` did; a removal carries what undoing it needs. */
export type McpServerRemoval =
  | { removed: false; agentsPruned: 0 }
  | { removed: true; agentsPruned: number; server: McpServerRow; prunedAgentIds: string[] };

export const McpServers = new McpServerModelClass();
