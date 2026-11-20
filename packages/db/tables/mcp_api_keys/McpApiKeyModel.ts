/**
 * McpApiKeyModel — Model class for the public.mcp_api_keys table.
 *
 * One row per API key minted for the MCP server surface (/mcp). Each key maps
 * to exactly one members row (kind = 'external') so external MCP clients get
 * identity, attribution stamps, and per-member permissions. The plaintext
 * token is never stored — only its SHA-256 hex hash (key_hash); the token is
 * shown once at mint time. Revocation deletes the row outright (no soft-revoke
 * state); deleting the member removes its keys via ON DELETE CASCADE.
 */

import { Model } from '@snaglet/db/Model';

export interface McpApiKeyRow {
  id: string;
  memberId: string;
  name: string;
  keyHash: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const KEY_COLUMNS = `id, member_id, name, key_hash, created_at, last_used_at`;

class McpApiKeyModelClass extends Model<McpApiKeyRow> {
  constructor() {
    super({
      table: 'mcp_api_keys',
      primaryKey: 'id',
    });
  }

  async create(input: { memberId: string; name: string; keyHash: string }): Promise<McpApiKeyRow> {
    const row = await this.queryOne<McpApiKeyRow>(
      `INSERT INTO public.mcp_api_keys (member_id, name, key_hash)
       VALUES ($1, $2, $3)
       RETURNING ${KEY_COLUMNS}`,
      [input.memberId, input.name, input.keyHash]
    );
    return row!;
  }

  /** All client connections, newest first (MCP activity tree). */
  async listAll(): Promise<McpApiKeyRow[]> {
    return this.query<McpApiKeyRow>(
      `SELECT ${KEY_COLUMNS} FROM public.mcp_api_keys ORDER BY created_at DESC`
    );
  }

  /** Resolve a key by its SHA-256 hex hash. Revoked keys are deleted, so a
   *  present row is by definition active. */
  async findActiveByHash(keyHash: string): Promise<McpApiKeyRow | null> {
    return this.queryOne<McpApiKeyRow>(
      `SELECT ${KEY_COLUMNS} FROM public.mcp_api_keys WHERE key_hash = $1`,
      [keyHash]
    );
  }

  override async findById(id: string): Promise<McpApiKeyRow | null> {
    return this.queryOne<McpApiKeyRow>(
      `SELECT ${KEY_COLUMNS} FROM public.mcp_api_keys WHERE id = $1`,
      [id]
    );
  }

  /** Rename the client connection without changing its credential or member identity. */
  async rename(id: string, name: string): Promise<McpApiKeyRow | null> {
    return this.queryOne<McpApiKeyRow>(
      `UPDATE public.mcp_api_keys
       SET name = $2
       WHERE id = $1
       RETURNING ${KEY_COLUMNS}`,
      [id, name]
    );
  }

  /**
   * Revoke = DELETE the key row (returns the deleted row, or null if it was
   * already gone). The kind='external' member is deliberately NOT deleted — it
   * retains attribution for anything the key created; the member's FK cascade
   * runs member→keys, not key→member.
   */
  async revoke(id: string): Promise<McpApiKeyRow | null> {
    return this.queryOne<McpApiKeyRow>(
      `DELETE FROM public.mcp_api_keys WHERE id = $1 RETURNING ${KEY_COLUMNS}`,
      [id]
    );
  }

  /** Stamp last_used_at (auth middleware throttles how often this is called). */
  async touchLastUsed(id: string): Promise<void> {
    await this.query(`UPDATE public.mcp_api_keys SET last_used_at = now() WHERE id = $1`, [id]);
  }
}

export const McpApiKeys = new McpApiKeyModelClass();
