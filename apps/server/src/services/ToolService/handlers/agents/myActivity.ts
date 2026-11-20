import type { ToolHandler } from '@server/services/ToolService/types';
import { AgentActivityLog, getDb } from '@snaglet/db';
import { unique } from '@snaglet/shared/utils';
import { resolveActivityThreadId } from '@server/services/ToolService/tools/agents/activityThreadFilter';
import {
  emptyFilterHint,
  resolveActivityRowFilter,
} from '@server/services/ToolService/tools/agents/activityRowFilter';

const tool: ToolHandler = async (params, _settings, context) => {
  const agentId = context?.agentId;
  if (!agentId) {
    return JSON.stringify({ error: 'No agent context available.' });
  }

  const limit = Math.min((params.limit as number) ?? 50, 200);
  const runId = params.run_id as string | undefined;
  const lastNRuns = params.last_n_runs as number | undefined;
  const filter = resolveActivityRowFilter(params);
  const threadId = resolveActivityThreadId(params, context);

  let rows;

  if (runId) {
    rows = await AgentActivityLog.getByRunId(runId, limit, { threadId, ...filter });
  } else if (lastNRuns && lastNRuns > 0) {
    rows = await AgentActivityLog.getRecentRunActivity(agentId, {
      runCount: lastNRuns,
      limit,
      threadId,
      ...filter,
    });
  } else {
    rows = await AgentActivityLog.listRecentActivity({
      agentId,
      limit,
      threadId,
      ...filter,
    });
  }

  const runIds = unique(rows.map((r) => r.runId).filter(Boolean)) as string[];
  const runMeta: Record<
    string,
    { status: string; model: string; started_at: string; finished_at: string | null }
  > = {};

  if (runIds.length > 0) {
    const pool = getDb();
    const placeholders = runIds.map((_, i) => `$${i + 1}`).join(', ');
    const runRows = await pool.query(
      `SELECT id, status, model, started_at, finished_at FROM runs WHERE id IN (${placeholders})`,
      runIds
    );
    for (const r of runRows.rows) {
      runMeta[r.id] = {
        status: r.status,
        model: r.model,
        started_at: r.started_at,
        finished_at: r.finished_at,
      };
    }
  }

  const entries = rows.map((r) => ({
    time: r.createdAt,
    run_id: r.runId,
    action: r.actionType,
    tool: r.tool ?? undefined,
    reason: r.reason ?? undefined,
    input_summary: r.toolInput ? JSON.stringify(r.toolInput).slice(0, 200) : undefined,
  }));

  const hint = entries.length === 0 ? emptyFilterHint(params) : undefined;
  return JSON.stringify({
    count: entries.length,
    ...(hint ? { hint } : {}),
    runs: runMeta,
    entries,
  });
};

export default tool;
