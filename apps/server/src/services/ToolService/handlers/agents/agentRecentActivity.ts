import type { ToolHandler } from '@server/services/ToolService/types';
import { AgentActivityLog, getDb } from '@snaglet/db';
import { helperAgentExclusionSql } from '@snaglet/db/tables/agents/visibility';
import { resolveActivityThreadId } from '@server/services/ToolService/tools/agents/activityThreadFilter';
import { unique } from '@snaglet/shared/utils';
import {
  emptyFilterHint,
  resolveActivityRowFilter,
} from '@server/services/ToolService/tools/agents/activityRowFilter';

const tool: ToolHandler = async (params, _settings, context) => {
  const agentName = (params.agent_name as string | undefined)?.trim();
  if (!agentName) {
    return JSON.stringify({ error: "Missing required 'agent_name'." });
  }

  const pool = getDb();

  // Resolve agent name -> UUID (case-insensitive). Prefer exact match, fall back to ILIKE.
  // Subagent helpers are not addressable by name (one may share a real
  // agent's name).
  const agentLookup = await pool.query<{ id: string; name: string }>(
    `SELECT a.id, a.name FROM agents a
     WHERE LOWER(a.name) = LOWER($1) AND ${helperAgentExclusionSql('a')}
     LIMIT 1`,
    [agentName]
  );

  let resolved = agentLookup.rows[0];
  if (!resolved) {
    const fuzzy = await pool.query<{ id: string; name: string }>(
      `SELECT a.id, a.name FROM agents a
        WHERE a.name ILIKE $1 AND ${helperAgentExclusionSql('a')}
        ORDER BY a.name LIMIT 5`,
      [`%${agentName}%`]
    );
    if (fuzzy.rows.length === 0) {
      return JSON.stringify({
        error: `No agent matched '${agentName}'.`,
        hint: "Try the agent's display name (e.g. 'Patty', 'Clio').",
      });
    }
    if (fuzzy.rows.length > 1) {
      return JSON.stringify({
        error: `Ambiguous agent name '${agentName}'.`,
        candidates: fuzzy.rows.map((r) => r.name),
      });
    }
    resolved = fuzzy.rows[0];
  }

  const agentId = resolved.id;
  const limit = Math.min((params.limit as number) ?? 50, 200);
  const runId = params.run_id as string | undefined;
  const lastNRuns = params.last_n_runs as number | undefined;
  const filter = resolveActivityRowFilter(params);
  const threadId = resolveActivityThreadId(params, context);
  const before = params.before ? new Date(params.before as string) : undefined;
  const includeInputPreview = params.include_input_preview === true;

  let rows;
  if (runId) {
    rows = await AgentActivityLog.getByRunId(runId, limit, { threadId, ...filter });
    // Filter to the resolved agent in case the run had multiple actors.
    rows = rows.filter((r) => r.agentId === agentId);
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
      before,
      ...filter,
    });
  }

  const runIds = unique(rows.map((r) => r.runId).filter(Boolean)) as string[];
  const runMeta: Record<
    string,
    { status: string; model: string; started_at: string; finished_at: string | null }
  > = {};

  if (runIds.length > 0) {
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
    input_summary:
      includeInputPreview && r.toolInput ? JSON.stringify(r.toolInput).slice(0, 200) : undefined,
  }));

  const hasMore = rows.length === limit;
  const oldestEntryTime = rows.length > 0 ? rows[rows.length - 1].createdAt : null;

  const hint = entries.length === 0 ? emptyFilterHint(params) : undefined;
  return JSON.stringify({
    agent: { id: agentId, name: resolved.name },
    count: entries.length,
    ...(hint ? { hint } : {}),
    has_more: hasMore,
    oldest_entry_time: oldestEntryTime,
    runs: runMeta,
    entries,
  });
};

export default tool;
