/**
 * find_conversation — find past conversations across threads by topic, using
 * thread summaries.
 *
 * Search strategy: reuse the workspace semantic engine over the
 * `thread_summary` kind. That engine already runs hybrid (vector + FTS) when
 * embeddings are enabled and degrades to keyword-only (FTS) when they are not
 * — it gates the vector channel on the `useVector` preference, which is false
 * when the embedder is unavailable. So passing mode='hybrid' gives the
 * requested "hybrid / vector when embeddings is enabled, keyword otherwise"
 * behavior for free.
 *
 * Project behavior (the point of this tool vs. workspace_search):
 *   - 'prioritize' (default): search the whole workspace, then float the
 *     caller's project threads to the top without dropping anything else.
 *   - 'only': restrict to the caller's project.
 *   - 'all': ignore the caller's project (plain relevance order).
 * When the caller is not inside a project, all three behave identically.
 */

import type { ToolHandler } from '@server/services/ToolService/types';
import { searchSemanticWorkspace } from '../workspaceSearch/semantic';
import type { ThreadSummaryHit } from '../workspaceSearch/types';
import { resolveCallerProject, mapThreadsToProjects } from './projectScope';

type ProjectScope = 'prioritize' | 'only' | 'all';

function parseLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? Math.floor(raw) : NaN;
  if (!Number.isFinite(n)) return 8;
  return Math.min(25, Math.max(1, n));
}

function parseProjectScope(raw: unknown): ProjectScope {
  return raw === 'only' || raw === 'all' ? raw : 'prioritize';
}

function trimToOneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

const handler: ToolHandler = async (input, _settings, context) => {
  const args = (input ?? {}) as Record<string, unknown>;
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    return JSON.stringify({ error: 'query is required', conversations: [] });
  }
  const limit = parseLimit(args.limit);
  const scope = parseProjectScope(args.project_scope);

  const callerThreadId = context?.threadId ?? null;
  const callerProject = await resolveCallerProject(callerThreadId);

  // Over-fetch candidates so prioritize/only re-ranking has room to work, and
  // so 'only' still returns enough after filtering out other projects.
  const candidateLimit = Math.min(100, limit * 4);

  const hits = await searchSemanticWorkspace({
    query,
    kinds: ['thread_summary'],
    mode: 'hybrid',
    limit: candidateLimit,
    // Workspace-wide on purpose: we PRIORITIZE the caller's project rather than
    // limit to it. 'only' is enforced by post-filtering below.
    allowedContainerIds: null,
    threadId: callerThreadId,
    graphDepth: 0,
    timeRange: null,
    fileProjectId: null,
    filePathPrefix: null,
  });

  const summaries = hits.filter((h): h is ThreadSummaryHit => h.kind === 'thread_summary');

  // Collapse to one result per thread (a thread can have summaries per agent),
  // keeping the highest-ranked (earliest) summary for each.
  const byThread = new Map<string, ThreadSummaryHit>();
  for (const hit of summaries) {
    if (!hit.threadId) continue;
    if (!byThread.has(hit.threadId)) byThread.set(hit.threadId, hit);
  }
  let ordered = Array.from(byThread.values());

  // Map each result thread to its enclosing project (batched) so we can decide
  // which ones belong to the caller's project.
  const projectByThread =
    callerProject != null
      ? await mapThreadsToProjects(ordered.map((h) => h.threadId))
      : new Map<string, string>();

  const inCallerProject = (hit: ThreadSummaryHit): boolean =>
    callerProject != null && projectByThread.get(hit.threadId) === callerProject.projectId;

  if (callerProject != null && scope === 'only') {
    ordered = ordered.filter(inCallerProject);
  } else if (callerProject != null && scope === 'prioritize') {
    // Stable partition: caller-project hits first, everything else after, each
    // group preserving its original relevance order.
    const own: ThreadSummaryHit[] = [];
    const rest: ThreadSummaryHit[] = [];
    for (const hit of ordered) {
      (inCallerProject(hit) ? own : rest).push(hit);
    }
    ordered = [...own, ...rest];
  }
  // scope === 'all', or no caller project: leave relevance order untouched.

  const conversations = ordered.slice(0, limit).map((hit) => ({
    thread_id: hit.threadId,
    thread_title: hit.threadTitle ?? '(untitled thread)',
    summary: hit.summaryText ? trimToOneLine(hit.summaryText, 400) : null,
    in_caller_project: inCallerProject(hit),
  }));

  return JSON.stringify({
    query,
    project_scope: scope,
    caller_project: callerProject
      ? { id: callerProject.projectId, name: callerProject.projectName }
      : null,
    embeddings_note: 'Hybrid search auto-degrades to keyword-only when embeddings are disabled.',
    count: conversations.length,
    conversations,
  });
};

export default handler;
