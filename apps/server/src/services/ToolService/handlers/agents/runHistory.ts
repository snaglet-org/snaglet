import type { ToolHandler } from '@server/services/ToolService/types';
import { AgentActivityLog, getDb } from '@snaglet/db';
import { clamp } from '@snaglet/shared/utils';
import { resolveActivityThreadId } from '@server/services/ToolService/tools/agents/activityThreadFilter';
import { unique } from '@snaglet/shared/utils';
import {
  emptyFilterHint,
  resolveActivityRowFilter,
} from '@server/services/ToolService/tools/agents/activityRowFilter';

interface RunInfo {
  id: string;
  status: string;
  model: string;
  started_at: string;
  finished_at: string | null;
  duration_seconds: number | null;
}

interface ActivityEntry {
  time: string;
  run_id: string | null;
  action: string;
  tool?: string;
  reason?: string;
  tool_input?: unknown;
  tool_output?: unknown;
}

function truncate(value: unknown, maxLen: number): unknown {
  if (value == null) return undefined;
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str.length <= maxLen) {
    return typeof value === 'string' ? value : JSON.parse(str);
  }
  return str.slice(0, maxLen) + `... [truncated, ${str.length - maxLen} chars omitted]`;
}

const tool: ToolHandler = async (params, _settings, context) => {
  const agentId = context?.agentId;
  if (!agentId) {
    return JSON.stringify({ error: 'No agent context available.' });
  }

  const lastNRuns = clamp((params.last_n_runs as number) ?? 1, 1, 5);
  const limit = clamp((params.limit as number) ?? 30, 1, 100);
  const runId = typeof params.run_id === 'string' && params.run_id ? params.run_id : undefined;
  const filter = resolveActivityRowFilter(params);
  const includeOutputs = (params.include_outputs as boolean) ?? true;
  const outputMaxLen = clamp((params.output_max_length as number) ?? 2000, 100, 10000);
  const threadId = resolveActivityThreadId(params, context);

  // run_id selects one run (only this agent's entries); otherwise the last N runs.
  const rows = runId
    ? (await AgentActivityLog.getByRunId(runId, limit, { threadId, ...filter })).filter(
        (r) => r.agentId === agentId
      )
    : await AgentActivityLog.getRecentRunActivity(agentId, {
        runCount: lastNRuns,
        limit,
        threadId,
        ...filter,
      });

  const runIds = unique(rows.map((r) => r.runId).filter(Boolean)) as string[];
  const runs: Record<string, RunInfo> = {};

  if (runIds.length > 0) {
    const pool = getDb();
    const placeholders = runIds.map((_, i) => `$${i + 1}`).join(', ');
    const runRows = await pool.query(
      `SELECT id, status, model, started_at, finished_at FROM runs WHERE id IN (${placeholders})`,
      runIds
    );
    for (const r of runRows.rows) {
      const startMs = new Date(r.started_at).getTime();
      const endMs = r.finished_at ? new Date(r.finished_at).getTime() : null;
      runs[r.id] = {
        id: r.id,
        status: r.status,
        model: r.model,
        started_at: r.started_at,
        finished_at: r.finished_at,
        duration_seconds: endMs ? Math.round((endMs - startMs) / 1000) : null,
      };
    }
  }

  const entries: ActivityEntry[] = rows.map((r) => {
    const entry: ActivityEntry = {
      time: r.createdAt,
      run_id: r.runId,
      action: r.actionType,
    };

    if (r.tool) entry.tool = r.tool;
    if (r.reason) entry.reason = r.reason;

    if (r.toolInput) {
      entry.tool_input = truncate(r.toolInput, outputMaxLen);
    }

    if (includeOutputs && r.toolOutput) {
      entry.tool_output = truncate(r.toolOutput, outputMaxLen);
    }

    return entry;
  });

  const hint = entries.length === 0 ? emptyFilterHint(params) : undefined;
  return JSON.stringify({
    agent_id: agentId,
    runs_retrieved: Object.keys(runs).length,
    total_entries: entries.length,
    ...(hint ? { hint } : {}),
    runs,
    entries,
  });
};

export default tool;
