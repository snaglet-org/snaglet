import { Model } from '@snaglet/db/Model';
import type { NodeRunner } from '@snaglet/db/tables/nodes';
import type { UnattendedPolicy } from '@snaglet/shared/types';

export type HookBuildStatus = 'pending' | 'building' | 'ready' | 'failed' | 'missing';

export interface HookRegistrationRow {
  id: string;
  name: string;
  sourcePath: string;
  enabled: boolean;
  /**
   * Agent the hook acts as: its tool access judges the hook's calls and
   * what the hook posts or writes is attributed to it. Null: the event's agent,
   * else the ghost system actor.
   */
  runAsAgentId: string | null;
  /**
   * The `buildHash` run as was set for. A new source or build clears run as
   * (setBuildState), and a run whose bundle no longer hashes to it is refused.
   */
  runAsBuildHash: string | null;
  buildStatus: HookBuildStatus;
  sourceHash: string | null;
  buildHash: string | null;
  sdkHash: string | null;
  builtPath: string | null;
  lastError: string | null;
  lastBuiltAt: string | null;
  /** What a run this hook wakes does with a tool call that would ask. */
  unattendedPolicy: UnattendedPolicy;
  createdAt: string;
  updatedAt: string;
}

interface CreateHookRegistrationInput {
  id: string;
  name: string;
  sourcePath: string;
  enabled?: boolean;
  buildStatus?: HookBuildStatus;
}

type UpdateHookRegistrationInput = Partial<
  Pick<
    HookRegistrationRow,
    | 'sourcePath'
    | 'enabled'
    | 'buildStatus'
    | 'sourceHash'
    | 'buildHash'
    | 'sdkHash'
    | 'builtPath'
    | 'lastError'
    | 'lastBuiltAt'
  >
>;

class HookRegistrationModelClass extends Model<
  HookRegistrationRow,
  CreateHookRegistrationInput,
  UpdateHookRegistrationInput
> {
  constructor() {
    super({ table: 'hook_registrations', primaryKey: 'id' });
  }

  async listAll(): Promise<HookRegistrationRow[]> {
    return this.query<HookRegistrationRow>('SELECT * FROM hook_registrations ORDER BY name');
  }

  async findByName(name: string): Promise<HookRegistrationRow | null> {
    return this.queryOne<HookRegistrationRow>(
      'SELECT * FROM hook_registrations WHERE name=$1 LIMIT 1',
      [name]
    );
  }

  async discover(input: {
    id: string;
    name: string;
    sourcePath: string;
    enabledForFirstRegistration: boolean;
  }): Promise<HookRegistrationRow> {
    const rows = await this.query<HookRegistrationRow>(
      `INSERT INTO hook_registrations (id, name, source_path, enabled)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (name) DO UPDATE SET source_path=EXCLUDED.source_path, updated_at=now()
       RETURNING *`,
      [input.id, input.name, input.sourcePath, input.enabledForFirstRegistration]
    );
    return rows[0];
  }

  async setUnattendedPolicy(
    name: string,
    policy: UnattendedPolicy
  ): Promise<HookRegistrationRow | null> {
    return this.queryOne<HookRegistrationRow>(
      `UPDATE hook_registrations SET unattended_policy=$2, updated_at=now()
       WHERE name=$1 RETURNING *`,
      [name, policy]
    );
  }

  async setEnabled(name: string, enabled: boolean): Promise<HookRegistrationRow | null> {
    return this.queryOne<HookRegistrationRow>(
      `UPDATE hook_registrations SET enabled=$2, updated_at=now()
       WHERE name=$1 RETURNING *`,
      [name, enabled]
    );
  }

  async deleteByName(name: string, runner: NodeRunner = this.pool): Promise<boolean> {
    const result = await runner.query<{ id: string }>(
      'DELETE FROM public.hook_registrations WHERE name=$1 RETURNING id',
      [name]
    );
    return (result.rowCount ?? result.rows.length) > 0;
  }

  async setBuildState(
    name: string,
    state: {
      buildStatus: HookBuildStatus;
      sourceHash?: string | null;
      buildHash?: string | null;
      sdkHash?: string | null;
      builtPath?: string | null;
      lastError?: string | null;
      builtNow?: boolean;
    }
  ): Promise<HookRegistrationRow | null> {
    // New code (a changed hook.ts, its triggers included, or a changed bundle:
    // a sibling import it pulls in, or a new SDK) drops an
    // `auto-approve-allowed` choice back to `skip` in the same write that
    // records the new hashes: a person approved the code that was there, not
    // this code, and must choose again. Run as is cleared the same way, and on
    // any build other than the one it was set for.
    return this.queryOne<HookRegistrationRow>(
      `UPDATE hook_registrations SET
         unattended_policy=CASE
           WHEN ($3::text IS NOT NULL AND source_hash IS DISTINCT FROM $3::text)
             OR ($4::text IS NOT NULL AND build_hash IS DISTINCT FROM $4::text) THEN 'skip'
           ELSE unattended_policy
         END,
         run_as_agent_id=CASE
           WHEN ($3::text IS NOT NULL AND source_hash IS DISTINCT FROM $3::text)
             OR ($4::text IS NOT NULL AND run_as_build_hash IS DISTINCT FROM $4::text) THEN NULL
           ELSE run_as_agent_id
         END,
         run_as_build_hash=CASE
           WHEN ($3::text IS NOT NULL AND source_hash IS DISTINCT FROM $3::text)
             OR ($4::text IS NOT NULL AND run_as_build_hash IS DISTINCT FROM $4::text) THEN NULL
           ELSE run_as_build_hash
         END,
         build_status=$2,
         source_hash=COALESCE($3, source_hash),
         build_hash=COALESCE($4, build_hash),
         sdk_hash=COALESCE($5, sdk_hash),
         built_path=COALESCE($6, built_path),
         last_error=$7,
         last_built_at=CASE WHEN $8 THEN now() ELSE last_built_at END,
         updated_at=now()
       WHERE name=$1 RETURNING *`,
      [
        name,
        state.buildStatus,
        state.sourceHash ?? null,
        state.buildHash ?? null,
        state.sdkHash ?? null,
        state.builtPath ?? null,
        state.lastError ?? null,
        state.builtNow ?? false,
      ]
    );
  }

  /**
   * Set (or clear, with null) the agent a hook runs as, for the build that is
   * registered now (`build_hash`). Only a ready build can take one. The caller
   * has already checked the agent exists, is not archived and is not ghost.
   * Null when no such hook, or (setting an agent) it has no ready build.
   */
  async setRunAs(name: string, agentId: string | null): Promise<HookRegistrationRow | null> {
    return this.queryOne<HookRegistrationRow>(
      `UPDATE hook_registrations SET
         run_as_agent_id=$2,
         run_as_build_hash=CASE WHEN $2::text IS NULL THEN NULL ELSE build_hash END,
         updated_at=now()
       WHERE name=$1
         AND ($2::text IS NULL OR (build_status = 'ready' AND build_hash IS NOT NULL))
       RETURNING *`,
      [name, agentId]
    );
  }
}

export const HookRegistrations = new HookRegistrationModelClass();
