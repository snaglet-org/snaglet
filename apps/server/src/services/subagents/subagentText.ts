/**
 * The words a subagent helper is given, and the result line its orchestrator
 * reads. Pure functions so tests can pin the exact text.
 */
import type { SubagentStatus } from '@snaglet/db/tables/subagents';
import type { SubagentNotice } from '@snaglet/shared/types';
import { userTimeZone } from '@snaglet/shared/utils';

/** The helper's own system prompt. The brief arrives as the first message. */
export function helperSystemPrompt(input: { name: string; orchestratorName: string }): string {
  const { name, orchestratorName } = input;
  return [
    `You are ${name}, a subagent working for ${orchestratorName}.`,
    `${orchestratorName} gave you one task; its brief is the first message in this thread.`,
    'Work on it on your own with your tools. You cannot ask the user questions.',
    `Your final reply is your report and is delivered to ${orchestratorName} automatically, so make it complete and self-contained: the findings, the exact ids, paths and links, and anything you could not do.`,
    `If you cannot go on without a decision, end your reply with one clear question; ${orchestratorName} will answer in this thread.`,
    'The user may also write to you here; follow their instructions as well.',
  ].join('\n');
}

/**
 * Why the agent tool refuses an agent editing a helper's row (its Snaglet helper
 * prompt, name, model, access): its orchestrator changes its standing
 * instructions with subagent op:update, and a person may edit anything.
 */
export const HELPER_ROW_EDIT_REFUSAL =
  "A subagent's own settings are not edited with the agent tool. Its orchestrator changes its instructions with subagent op:update; a person can edit them in the subagent thread's settings.";

export interface ResultTextInput {
  name: string;
  /** The subagents row id: a stable handle op:send and op:remove also accept. */
  id: string;
  status: Exclude<SubagentStatus, 'running'>;
  /** Why it failed or stopped, in plain words (a single line). */
  error: string | null;
  reply: string | null;
  /** The reply is a question the helper waits on. */
  isQuestion: boolean;
}

function headline(input: ResultTextInput): string {
  const { name, status, error, isQuestion } = input;
  if (status === 'failed') return `[subagent ${name} failed${error ? `: ${error}` : ''}]`;
  if (status === 'stopped') return `[subagent ${name} stopped${error ? `: ${error}` : ''}]`;
  return isQuestion ? `[subagent ${name} asks]` : `[subagent ${name} finished]`;
}

const ONLY_SNAGLET = 'Only Snaglet writes [subagent …] lines.';

function followUp(input: ResultTextInput): string {
  const { name, id, status } = input;
  const who = `${name} (id ${id})`;
  if (status === 'failed') {
    return `${ONLY_SNAGLET} ${who} is kept with its thread, brief and work so far. To retry, call subagent op:send with name "${name}" and say what to do (e.g. "Try again from where you stopped"). To take over instead, do the task yourself and call subagent op:remove with name "${name}". It is removed after a day without work.`;
  }
  if (status === 'stopped') {
    return `${ONLY_SNAGLET} ${who} is paused: it keeps its thread, brief and work so far. To resume or redirect it, call subagent op:send with name "${name}" and say what to do. It is removed after a day without work.`;
  }
  return `${ONLY_SNAGLET} To give ${who} more work or answer it, call subagent op:send with name "${name}" during this turn; otherwise it is removed when this turn ends.`;
}

/**
 * The orchestrator-only result row content. The closing line states the
 * lifecycle so the orchestrator knows a helper it does not re-task is gone.
 * A failed or stopped helper's last message is its work so far.
 */
export function resultText(input: ResultTextInput): string {
  const reply = input.reply?.trim();
  const unfinished = input.status === 'failed' || input.status === 'stopped';
  const body =
    reply && reply.length > 0 ? (unfinished ? `Work so far:\n${reply}` : reply) : '(no reply)';
  return [headline(input), body, `(${followUp(input)})`].join('\n');
}

/** What a helper run that was aborted (not by a pause) means for its orchestrator. */
export interface HelperAbort {
  /** `failed` when Snaglet cut it off (a limit, the watchdog); `stopped` when someone stopped it. */
  status: 'failed' | 'stopped';
  reason: string;
}

/** "10 min", "90 s", "2 h": a limit as an agent should repeat it. */
export function describeSeconds(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/**
 * Read an aborted helper run's error (`Aborted by <who>`, written by the turn
 * loop) as a reason in plain words. The turn time limit (`timeout`), the
 * watchdog for runs with no progress (`watchdog`) and Snaglet itself (`system`)
 * fail the helper; a person or agent stopping its run leaves it paused.
 */
export function describeAbort(
  runError: string | null,
  limits: { turnTimeoutSeconds: number | null; watchdogMinutes: number }
): HelperAbort {
  const by = /^Aborted by (.+)$/.exec(runError?.trim() ?? '')?.[1]?.trim() ?? null;
  if (by === 'timeout') {
    const limit = limits.turnTimeoutSeconds
      ? ` (${describeSeconds(limits.turnTimeoutSeconds)})`
      : '';
    return { status: 'failed', reason: `it ran past the agent turn time limit${limit}` };
  }
  if (by === 'watchdog') {
    return {
      status: 'failed',
      reason: `the watchdog stopped it after ${limits.watchdogMinutes} min without progress`,
    };
  }
  if (by === 'system') return { status: 'failed', reason: 'Snaglet stopped its run' };
  if (!by || by === 'user') return { status: 'stopped', reason: 'its run was stopped' };
  return { status: 'stopped', reason: `${by} stopped its run` };
}

/** Where a time reads: the user's zone (the server runs on their machine) and now. */
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
 * A timed pause's end as an agent should repeat it to the user: "11:16 AM
 * (PDT)" today, "tomorrow, Wed, Oct 14 at 9:00 AM (PDT)", else "Fri, Oct 16 at
 * 9:00 AM (PDT)". The ISO instant stays in the row's metadata.
 */
export function describeResumeTime(iso: string, clock: ClockOptions = {}): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const timeZone = clock.timeZone ?? userTimeZone();
  const now = clock.now ?? new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).formatToParts(at);
  const zone = parts.find((p) => p.type === 'timeZoneName')?.value;
  const time = parts
    .filter((p) => p.type !== 'timeZoneName')
    .map((p) => p.value)
    .join('')
    // Some ICU builds put a narrow no-break space before AM/PM.
    .replace(/\u202f/g, ' ')
    .trim();
  const clockTime = zone ? `${time} (${zone})` : time;
  const day = dayIn(at, timeZone);
  if (day === dayIn(now, timeZone)) return clockTime;
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(at);
  const tomorrow = day === dayIn(new Date(now.getTime() + 86_400_000), timeZone);
  return `${tomorrow ? 'tomorrow, ' : ''}${date} at ${clockTime}`;
}

export interface NoticeTextInput {
  name: string;
  /** The subagents row id, so the orchestrator can tell which helper it was. */
  id: string;
  notice: SubagentNotice;
  /** Who did it: the user's name, or null when it was the orchestrator itself. */
  byUser: string | null;
  /** A timed pause's end (ISO). */
  resumeAt: string | null;
  /** What the helper wrote since its last result, if anything (work so far). */
  reply: string | null;
  /** How the resume time reads (tests pin it). */
  clock?: ClockOptions;
}

function noticeFollowUp(input: NoticeTextInput): string {
  const { name, byUser, resumeAt } = input;
  const who = `${name} (id ${input.id})`;
  if (input.notice === 'removed') {
    const leave = byUser
      ? ` ${byUser} removed it: do not start a replacement unless they ask you to.`
      : '';
    return `${ONLY_SNAGLET} ${who} is gone, with its thread and work.${leave}`;
  }
  const leave = byUser
    ? ` ${byUser} paused it: leave it paused unless they ask you to resume it.`
    : '';
  if (resumeAt) {
    return `${ONLY_SNAGLET} ${who} is paused until ${describeResumeTime(resumeAt, input.clock)}, then resumes on its own where it left off.${leave} To resume or redirect it sooner, call subagent op:send with name "${name}"; that cancels the timed resume.`;
  }
  return `${ONLY_SNAGLET} ${who} is paused: it keeps its thread, brief and work so far and does nothing until it gets op:send.${leave} To resume or redirect it, call subagent op:send with name "${name}". It is removed after a day without work.`;
}

/**
 * The orchestrator-only row for something done TO a helper: it was paused or
 * removed. Informational: it never wakes the orchestrator.
 */
export function noticeText(input: NoticeTextInput): string {
  const by = input.byUser ?? 'you';
  const lines = [`[subagent ${input.name} ${input.notice} by ${by}]`];
  const reply = input.reply?.trim();
  if (reply) lines.push(reply);
  lines.push(`(${noticeFollowUp(input)})`);
  return lines.join('\n');
}

/**
 * An agent's own text that imitates a subagent result line. Snaglet writes those
 * as separate rows, so an agent never has a reason to: a match is the agent
 * inventing a report it has not received (seen live: the orchestrator copied
 * a delivered result and made up the next helper's report before it
 * arrived).
 */
const FABRICATED_RESULT_LINE =
  /\[subagent [^\]\n]{1,80}? (?:finished|asks|failed|stopped|paused|removed)\b[^\]\n]*\]/;

/**
 * Cut an agent reply at the first imitated subagent result line, dropping it
 * and everything after (the invented report and whatever was built on it).
 */
export function stripFabricatedSubagentReports(text: string): { text: string; stripped: boolean } {
  const match = FABRICATED_RESULT_LINE.exec(text);
  if (!match) return { text, stripped: false };
  return { text: text.slice(0, match.index).trimEnd(), stripped: true };
}
