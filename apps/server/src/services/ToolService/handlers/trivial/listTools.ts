import { Tools } from '@snaglet/db';
import type { ToolHandler } from '@server/services/ToolService/types';

/** One-liner cap so a single verbose description can't bloat the catalog. */
const MAX_DESCRIPTION_CHARS = 160;

function oneLiner(description: string | null | undefined): string {
  const firstLine = String(description ?? '')
    .split('\n')[0]
    .trim();
  return firstLine.length > MAX_DESCRIPTION_CHARS
    ? firstLine.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd() + '…'
    : firstLine;
}

// Summary mode (default and only mode). Emits one line of metadata per tool
// (id, name, one-line description, tier, aliases, assigned flag) but not the
// full parameters_schema: every schema together runs to ~249K chars and would
// blow the context window.
// The per-tool schema path is `tool(op:schema)` (called after you pick a tool).
const tool: ToolHandler = async (_input, _settings, context) => {
  const agentId = String(context?.agentId ?? '');
  const rows = await Tools.listAvailableForAgent(agentId);

  const summarize = (t: (typeof rows)[number]) => ({
    id: t.id,
    name: t.name,
    description: oneLiner(t.description),
    tier: t.tier,
    aliases: t.aliases ?? [],
    assigned: t.assigned,
  });
  const assigned = rows.filter((t) => t.assigned).map(summarize);
  const unassigned = rows.filter((t) => !t.assigned).map(summarize);
  return JSON.stringify({
    contract_version: 'v1',
    mode: 'summary',
    note: 'Summaries only — parameters_schema is omitted to keep context small. Call tool with { op: "schema", name } to fetch the full parameters, keywords, and aliases for a single tool before invoking it.',
    assigned_count: assigned.length,
    unassigned_count: unassigned.length,
    assigned,
    unassigned,
  });
};

export default tool;
