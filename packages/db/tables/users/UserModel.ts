/**
 * UserModel — Model class for the users table.
 *
 * Extends the base Model with user-specific methods for OAuth upserts and
 * local user management. The avatar column is not part of the row type or
 * the consumer surface.
 */

import { Model } from '@snaglet/db/Model';
import { transaction } from '@snaglet/db/db';
import { Members } from '@snaglet/db/tables/members';
import { DEFAULT_USER_NAME } from '@snaglet/shared/constants';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  picture: string | null;
  active: boolean;
  authProvider: string;
  authProviderId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserInput {
  email: string;
  name: string;
  picture?: string | null;
  authProvider: string;
  authProviderId: string;
}

export interface UpdateUserInput {
  email?: string;
  name?: string;
  picture?: string | null;
  active?: boolean;
  authProvider?: string;
  authProviderId?: string;
}

export interface UpsertUserParams {
  authProvider: string;
  authProviderId: string;
  email: string;
  name: string;
  picture?: string | null;
}

export interface CreateLocalUserParams {
  name: string;
  email?: string;
  picture?: string | null;
  makeActive?: boolean;
}

const LOCAL_AUTH_PROVIDER = 'local';
const LOCAL_AUTH_PROVIDER_ID = 'local-user';
const LOCAL_USER_EMAIL = 'local-user@snaglet.local';
const LOCAL_USER_NAME = DEFAULT_USER_NAME;

function mapUserRow(row: Record<string, unknown>): UserRow {
  return {
    id: String(row.id),
    email: String(row.email ?? ''),
    name: String(row.name ?? ''),
    picture: row.picture == null ? null : String(row.picture),
    active: Boolean(row.active),
    authProvider: String(row.auth_provider ?? row.authProvider ?? ''),
    authProviderId: String(row.auth_provider_id ?? row.authProviderId ?? ''),
    createdAt: String(row.created_at ?? row.createdAt ?? ''),
    updatedAt: String(row.updated_at ?? row.updatedAt ?? ''),
  };
}

/**
 * Derive a stable text ID from a user's display name.
 * Matches the SQL expression used in the users_text_pk migration:
 *   lower(regexp_replace(trim(name), '[^a-zA-Z0-9]+', '_', 'g'))
 * e.g. "Local User" → "local_user", "Test User" → "test_user"
 */
export function computeUserId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
  return slug || 'user';
}

class UserModelClass extends Model<UserRow, CreateUserInput, UpdateUserInput> {
  private activeColumnPromise: Promise<boolean> | null = null;

  constructor() {
    super({
      table: 'users',
      primaryKey: 'id',
    });
  }

  private async hasActiveColumn(): Promise<boolean> {
    this.activeColumnPromise ??= this.queryOne<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'users'
            AND column_name = 'active'
       ) AS exists`
    ).then((row) => row?.exists ?? false);
    return this.activeColumnPromise;
  }

  /**
   * Upsert a user by auth provider + auth provider ID.
   * On conflict, updates email, name, and picture.
   */
  async upsertUser(params: UpsertUserParams): Promise<UserRow> {
    const id = computeUserId(params.name);
    const row = await this.queryOne<UserRow>(
      `INSERT INTO users (id, email, name, picture, auth_provider, auth_provider_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (auth_provider, auth_provider_id) DO UPDATE SET
         email      = EXCLUDED.email,
         name       = EXCLUDED.name,
         picture    = EXCLUDED.picture,
         updated_at = NOW()
       RETURNING *`,
      [
        id,
        params.email,
        params.name,
        params.picture ?? null,
        params.authProvider,
        params.authProviderId,
      ]
    );
    // Ensure the unified members registry has a row for this user. Decoupled
    // from thread participation on purpose — humans don't get
    // thread_participants rows, so this is the only place this bridge fires.
    await Members.ensureForUser(row!.id);
    return row!;
  }

  /** Return the currently active user, or null if none is flagged active. */
  async getActiveUser(): Promise<UserRow | null> {
    if (!(await this.hasActiveColumn())) return null;
    return this.queryOne<UserRow>(`SELECT * FROM users WHERE active = true LIMIT 1`);
  }

  /**
   * Mark user `id` as active and clear the flag on all other rows.
   * Uses a CTE so both updates run in a single statement.
   */
  async setActiveUser(id: string): Promise<UserRow | null> {
    if (!(await this.hasActiveColumn())) {
      return this.findById(id);
    }
    return this.queryOne<UserRow>(
      `WITH clear AS (
         UPDATE users SET active = false, updated_at = NOW() WHERE active = true AND id <> $1
       )
       UPDATE users SET active = true, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );
  }

  async createLocalUser(params: CreateLocalUserParams): Promise<UserRow> {
    const name = params.name.trim();
    const id = computeUserId(name);
    const email = params.email?.trim() || `${id}@snaglet.local`;
    const picture = params.picture ?? null;
    const makeActive = params.makeActive === true;

    return transaction(async (tx) => {
      const { rows: existingByName } = await tx.query<{ id: string }>(
        `SELECT id FROM public.users WHERE LOWER(name) = LOWER($1) LIMIT 1`,
        [name]
      );
      if (existingByName.length > 0) {
        throw Object.assign(new Error('A user with that name already exists'), {
          code: 'USER_DUPLICATE_NAME',
        });
      }

      const { rows: existingById } = await tx.query<{ id: string }>(
        `SELECT id FROM public.users WHERE id = $1 LIMIT 1`,
        [id]
      );
      if (existingById.length > 0) {
        throw Object.assign(new Error('A user with that name already exists'), {
          code: 'USER_DUPLICATE_NAME',
        });
      }

      if (makeActive && (await this.hasActiveColumn())) {
        await tx.query(
          `UPDATE public.users SET active = false, updated_at = NOW() WHERE active = true`
        );
      }

      const inserted = await tx.query<Record<string, unknown>>(
        `INSERT INTO public.users (id, email, name, picture, active, auth_provider, auth_provider_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         RETURNING *`,
        [id, email, name, picture, makeActive, LOCAL_AUTH_PROVIDER, id]
      );
      const row = inserted.rows[0];
      await tx.query(
        `INSERT INTO public.members (kind, user_id)
         VALUES ('user', $1)
         ON CONFLICT (user_id) WHERE user_id IS NOT NULL
         DO UPDATE SET updated_at = NOW()`,
        [id]
      );
      return mapUserRow(row);
    });
  }

  /**
   * Find a user by display name, case-insensitive exact match (after
   * trimming). Mirrors AgentModel.findByName's convention exactly, so the
   * `from`-param resolution (resolveFromSender.ts) can try "agent, then
   * member/user" with the same lookup shape on both sides. `users.name` has
   * no UNIQUE constraint (unlike agents.name), so ties resolve to whichever
   * row Postgres returns first — acceptable here since this only backs an
   * opt-in provenance label, not an identity/auth decision.
   */
  async findByName(name: string): Promise<UserRow | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    return this.queryOne<UserRow>(`SELECT * FROM users WHERE LOWER(name) = LOWER($1) LIMIT 1`, [
      trimmed,
    ]);
  }

  /**
   * Get or create the local user, returning the id.
   * Uses an upsert that does not modify existing data on conflict.
   */
  async getOrCreateLocalUser(): Promise<{ id: string }> {
    const id = computeUserId(LOCAL_USER_NAME); // 'local_user'
    const row = await this.queryOne<{ id: string }>(
      `INSERT INTO users (id, email, name, auth_provider, auth_provider_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (auth_provider, auth_provider_id) DO UPDATE SET
         updated_at = users.updated_at
       RETURNING id`,
      [id, LOCAL_USER_EMAIL, LOCAL_USER_NAME, LOCAL_AUTH_PROVIDER, LOCAL_AUTH_PROVIDER_ID]
    );
    // Ensure the unified members registry has a row for this user. Decoupled
    // from thread participation on purpose — humans don't get
    // thread_participants rows, so this is the only place this bridge fires.
    await Members.ensureForUser(row!.id);
    return row!;
  }
}

export const Users = new UserModelClass();
