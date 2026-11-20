import { Model } from '@snaglet/db/Model';
import type { HookRunRecord, HookRunSource, HookRunStatus } from '@snaglet/shared/types';
import { isoNow } from '@snaglet/shared/utils';
import type { NodeRunner } from '@snaglet/db/tables/nodes';

export interface CreateHookRunInput {
  id: string;
  hookName: string;
  source: HookRunSource;
  eventName: string;
  agentId?: string | null;
  threadId?: string | null;
  /** Hook chain depth the run executes at (`hook_runs.chain_depth`). */
  chainDepth?: number;
  startedAt?: string;
}

export interface FinishHookRunInput {
  status: Exclude<HookRunStatus, 'running'>;
  durationMs: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  finishedAt?: string;
}

export interface HookRunDeleteResult {
  deleted: number;
  ids: string[];
  hookNames: string[];
}

export interface HookRunRetentionPolicy {
  keepLatestPerHook: number;
  succeededRetention: string;
  failureRetention: string;
  batchSize: number;
}

class HookRunModelClass extends Model<HookRunRecord, CreateHookRunInput, FinishHookRunInput> {
  constructor() {
    super({
      table: 'hook_runs',
      primaryKey: 'id',
      updatedAtColumn: null,
      createdAtColumn: 'started_at',
    });
  }

  async start(input: CreateHookRunInput): Promise<HookRunRecord> {
    return this.create({
      ...input,
      agentId: input.agentId ?? null,
      threadId: input.threadId ?? null,
      startedAt: input.startedAt ?? isoNow(),
    });
  }

  async finish(id: string, input: FinishHookRunInput): Promise<HookRunRecord | null> {
    return this.queryOne<HookRunRecord>(
      `UPDATE hook_runs
         SET status=$2,
             duration_ms=$3,
             exit_code=$4,
             stdout=$5,
             stderr=$6,
             finished_at=$7
       WHERE id=$1
       RETURNING *`,
      [
        id,
        input.status,
        input.durationMs,
        input.exitCode,
        input.stdout.slice(0, 100_000),
        input.stderr.slice(0, 100_000),
        input.finishedAt ?? isoNow(),
      ]
    );
  }

  async listRecent(limit = 25): Promise<HookRunRecord[]> {
    return this.query<HookRunRecord>(
      `SELECT * FROM hook_runs
       ORDER BY started_at DESC, id DESC
       LIMIT $1`,
      [Math.min(Math.max(limit, 1), 100)]
    );
  }

  async listByHook(hookName: string, limit = 100): Promise<HookRunRecord[]> {
    return this.query<HookRunRecord>(
      `SELECT * FROM hook_runs
       WHERE hook_name=$1
       ORDER BY started_at DESC, id DESC
       LIMIT $2`,
      [hookName, Math.min(Math.max(limit, 1), 100)]
    );
  }

  async deleteByHookName(
    hookName: string,
    runner: NodeRunner = this.pool
  ): Promise<HookRunDeleteResult> {
    const result = await runner.query<{ id: string; hook_name: string }>(
      `DELETE FROM public.hook_runs
        WHERE hook_name = $1
        RETURNING id, hook_name`,
      [hookName]
    );
    return {
      deleted: result.rowCount ?? result.rows.length,
      ids: result.rows.map((row) => row.id),
      hookNames: [...new Set(result.rows.map((row) => row.hook_name))].sort(),
    };
  }

  /**
   * Delete one bounded batch of terminal history while retaining the latest N
   * rows for every hook regardless of age. Startup-interrupted rows are stored
   * as status=failed, so they follow the longer failure retention window.
   */
  async pruneTerminal(
    policy: HookRunRetentionPolicy,
    runner: NodeRunner = this.pool
  ): Promise<HookRunDeleteResult> {
    const keepLatest = Math.max(0, Math.floor(policy.keepLatestPerHook));
    const batchSize = Math.min(Math.max(1, Math.floor(policy.batchSize)), 5_000);
    const result = await runner.query<{ id: string; hook_name: string }>(
      `WITH ranked AS (
         SELECT id,
                hook_name,
                status,
                started_at,
                ROW_NUMBER() OVER (
                  PARTITION BY hook_name
                  ORDER BY started_at DESC, id DESC
                ) AS retention_rank
           FROM public.hook_runs
       ), candidates AS (
         SELECT id, started_at
           FROM ranked
          WHERE retention_rank > $1
            AND status <> 'running'
            AND (
              (status = 'succeeded' AND started_at < NOW() - $2::interval)
              OR
              (status IN ('failed', 'timed_out') AND started_at < NOW() - $3::interval)
            )
          ORDER BY started_at ASC, id ASC
          LIMIT $4
       ), deleted AS (
         DELETE FROM public.hook_runs h
          USING candidates c
          WHERE h.id = c.id
            AND h.status <> 'running'
          RETURNING h.id, h.hook_name
       )
       SELECT id, hook_name FROM deleted ORDER BY id`,
      [keepLatest, policy.succeededRetention, policy.failureRetention, batchSize]
    );
    return {
      deleted: result.rowCount ?? result.rows.length,
      ids: result.rows.map((row) => row.id),
      hookNames: [...new Set(result.rows.map((row) => row.hook_name))].sort(),
    };
  }

  async markInterrupted(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE hook_runs
       SET status='failed',
           stderr=CASE
             WHEN COALESCE(stderr, '') = '' THEN 'Snaglet stopped during this run'
             ELSE stderr
           END,
           finished_at=now()
       WHERE status='running'`
    );
    return result.rowCount ?? 0;
  }
}

export const HookRuns = new HookRunModelClass();
