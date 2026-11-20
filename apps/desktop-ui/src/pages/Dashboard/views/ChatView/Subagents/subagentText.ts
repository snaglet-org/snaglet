/**
 * The words the UI uses for subagent helpers: the result line in the
 * parent thread, the composer strip and the helper thread header. Pure, so
 * tests pin the exact copy. The result row's content is written by the
 * server's `resultText` (apps/server/src/services/subagents/subagentText.ts):
 * a `[subagent <name> …]` headline, the report, then a parenthesized line
 * telling the orchestrator about op:send.
 */
import type { SubagentNotice, SubagentStatus, SubagentSummary } from '@snaglet/shared/types';
import { userTimeZone } from '@snaglet/shared/utils';
import type { ThreadMessageSubagentResult, ThreadTreeNode } from '@desktop/utils/api';
import type { DetailSelection } from '@desktop/pages/Dashboard/selection/types';

/**
 * How a helper's result row reads: `asks` is a finished reply that ends in a
 * question; `paused` and `removed` are notices of what someone did to it.
 */
export type SubagentOutcome = 'finished' | 'asks' | 'failed' | 'stopped' | SubagentNotice;

/** The result row's first line, when it is the server's `[subagent …]` headline. */
function headlineOf(content: string): string | null {
  const first = content.split('\n', 1)[0] ?? '';
  return first.startsWith('[subagent ') && first.endsWith(']') ? first : null;
}

export function subagentOutcome(
  result: ThreadMessageSubagentResult,
  content: string
): SubagentOutcome {
  if (result.notice) return result.notice;
  if (result.status !== 'finished') return result.status;
  return headlineOf(content) === `[subagent ${result.name} asks]` ? 'asks' : 'finished';
}

/** Where a label's clock reads: the viewer's zone and now, unless a test pins them. */
export interface ClockOptions {
  now?: Date;
  timeZone?: string;
}

function dayIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * When a timed pause ends, in the viewer's zone: "3:00 PM" today, "tomorrow
 * 9:00 AM", else "Wed, Oct 14, 3:00 PM" (a pause lasts at most a week).
 */
export function pausedUntilTime(iso: string, opts: ClockOptions = {}): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const timeZone = opts.timeZone ?? userTimeZone();
  const now = opts.now ?? new Date();
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(at);
  const day = dayIn(at, timeZone);
  if (day === dayIn(now, timeZone)) return time;
  if (day === dayIn(new Date(now.getTime() + 86_400_000), timeZone)) return `tomorrow ${time}`;
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(at);
  return `${date}, ${time}`;
}

/**
 * "Patty's subagent Scout finished" — the compact line in the parent thread.
 * A notice names who did it unless it was the orchestrator itself, and when
 * a timed pause ends: "Patty's subagent Echo paused by Ana until 3:00 PM".
 */
export function subagentResultLabel(
  result: ThreadMessageSubagentResult,
  content: string,
  clock: ClockOptions = {}
): string {
  const label = `${result.orchestratorName}'s subagent ${result.name} ${subagentOutcome(result, content)}`;
  if (!result.notice) return label;
  const by =
    result.noticeBy && result.noticeBy !== result.orchestratorName ? ` by ${result.noticeBy}` : '';
  const until =
    result.notice === 'paused' && result.resumeAt
      ? ` until ${pausedUntilTime(result.resumeAt, clock)}`
      : '';
  return `${label}${by}${until}`;
}

export interface SubagentReport {
  /** Why it failed or stopped, from a `failed: <reason>` or `stopped: <reason>` headline. */
  error: string | null;
  /** The helper's report; empty when it gave none. */
  report: string;
}

/**
 * The part of a result row a person reads: the content minus the headline and
 * minus the closing note meant for the orchestrator.
 */
export function subagentReport(content: string, name: string): SubagentReport {
  const lines = content.split('\n');
  const headline = headlineOf(content);
  if (headline) lines.shift();
  const last = lines[lines.length - 1]?.trim() ?? '';
  const forOrchestrator = last.includes('op:send') || last.startsWith('(Only Snaglet writes');
  if (last.startsWith('(') && last.endsWith(')') && forOrchestrator) lines.pop();
  const report = lines.join('\n').trim();
  const reasonPrefix = [`[subagent ${name} failed: `, `[subagent ${name} stopped: `].find(
    (prefix) => headline?.startsWith(prefix)
  );
  const error =
    headline && reasonPrefix ? headline.slice(reasonPrefix.length, -1).trim() || null : null;
  return { error, report: report === '(no reply)' ? '' : report };
}

/**
 * Why a helper failed or stopped, for a tooltip on its chip or header; null
 * while it is fine. A paused helper reads "Paused: …".
 */
export function helperProblem(subagent: Pick<SubagentSummary, 'status' | 'error'>): string | null {
  if (!subagent.error) return null;
  if (subagent.status === 'failed') return `Failed: ${subagent.error}`;
  if (subagent.status === 'stopped') return `Paused: ${subagent.error}`;
  return null;
}

/** The helper thread's title, as the server names it ("Patty › Scout"). */
export function helperThreadTitle(orchestratorName: string | null, name: string): string {
  return orchestratorName ? `${orchestratorName} › ${name}` : name;
}

/** "Patty's subagent" — whose helper it is; the role line of its settings card. */
export function helperOwnerLabel(orchestratorName: string | null): string {
  return orchestratorName ? `${orchestratorName}'s subagent` : 'Subagent';
}

/** "Patty's subagent Scout" — the helper thread header's lead. */
export function helperLabel(subagent: Pick<SubagentSummary, 'name' | 'orchestratorName'>): string {
  return `${helperOwnerLabel(subagent.orchestratorName)} ${subagent.name}`;
}

/** A helper's live state: its row's status, or `waiting` on the user's approval. */
export type LiveSubagentState = SubagentStatus | 'waiting';

/**
 * A helper's live state: a tool approval pending in its thread waits for the
 * user; otherwise a live run in its thread counts as running.
 */
export function liveSubagentStatus(
  status: SubagentStatus,
  threadRunning: boolean,
  approvalPending = false
): LiveSubagentState {
  if (approvalPending) return 'waiting';
  return threadRunning ? 'running' : status;
}

/**
 * The state as the strip and header word it. A stopped helper is paused:
 * "paused", or "paused until 3:00 PM" when it resumes on its own.
 */
export function liveSubagentLabel(
  state: LiveSubagentState,
  resumeAt: string | null = null,
  clock: ClockOptions = {}
): string {
  if (state === 'waiting') return 'waiting for you';
  if (state === 'stopped') {
    return resumeAt ? `paused until ${pausedUntilTime(resumeAt, clock)}` : 'paused';
  }
  return state;
}

/**
 * Pane selection for a helper's hidden thread. Helper threads are in no list,
 * so the workspace-tree hydration could never fill `node` in; a minimal node
 * carries the title instead (the same pattern ActiveAgentsPopover uses). The
 * parent id marks the pane as a helper's, so a reload after the helper is
 * removed still shows it as removed.
 */
export function helperThreadSelection(
  threadId: string,
  title: string,
  parentThreadId: string
): DetailSelection {
  const node: ThreadTreeNode = {
    kind: 'thread',
    id: threadId,
    projectId: null,
    title,
    sortOrder: 0,
    lastMessageAt: null,
    createdAt: '',
    updatedAt: null,
  };
  return { kind: 'thread', thread_id: threadId, node, helperParentThreadId: parentThreadId };
}
