// Thin DB loader for turn replay: fetch a thread's messages, runs, and activity
// log, normalize them, and hand them to the pure assembleAgentPayload(). Kept
// separate so the assembly logic stays pure + unit-tested.
//
// Loads all messages and runs and the newest 5000 activity rows; downstream
// compression (compressMessages in promptBuilder) bounds the prompt size.

import { Messages, type MessageRow } from '@snaglet/db/tables/messages';
import { Runs } from '@snaglet/db/tables/runs';
import { AgentActivityLog } from '@snaglet/db/tables/agent_activity_log';
import {
  isSummaryBookkeepingActivity,
  loadLatestCompaction,
  type CompactionRecord,
} from '@server/services/summary/compactionRecord';
import { Agents } from '@snaglet/db/tables/agents';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { Users } from '@snaglet/db/tables/users';
import { readOriginalAgentName } from '@snaglet/shared/constants/systemAgents';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import type { ProviderMessage } from '@server/services/ProviderChatService/types';
import type { ContextBudget } from '@server/services/contextWindow/budget';
import {
  replayRunCapCeiling,
  shrinkReplayRunCap,
} from '@server/services/contextWindow/adaptiveLimits';
import {
  assembleAgentPayload,
  attachRelayedLegend,
  DEFAULT_REPLAY_RUN_TOKEN_CAP,
  estimateReplayTokens,
  type ReplayActivityRow,
  type ReplayMessageRow,
  type ReplayRun,
  type ReplayUnitSpan,
} from './replayAssembly';
import { isAgentRunEndedRow } from '../../agentRunEnded';
import { newcomerTailCap, planNewcomerCut } from './newcomerCut';

/**
 * A fixed per-run replay token cap from SNAGLET_REPLAY_RUN_TOKEN_CAP, or undefined when unset or
 * invalid (then the cap scales with the window; see assembleWithScaledCap).
 */
function resolveFixedReplayRunTokenCap(): number | undefined {
  const raw = process.env.SNAGLET_REPLAY_RUN_TOKEN_CAP;
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

type AssembleArgs = Parameters<typeof assembleAgentPayload>[0];

/**
 * assembleAgentPayload with the per-run token cap derived from the window. Over its cap, a run's
 * oldest tool results are trimmed or dropped, so the cap is a share of the fold threshold, not
 * a fixed 10k: an earlier run replays whole while the window has room. If the whole replay then
 * overshoots the room below the fold, it is assembled again with a proportionally tighter cap
 * (never below DEFAULT_REPLAY_RUN_TOKEN_CAP). `fixedCap` (the env override) wins; with neither
 * it nor a budget, DEFAULT_REPLAY_RUN_TOKEN_CAP applies.
 */
export function assembleWithScaledCap(
  args: Omit<AssembleArgs, 'runTokenCap'> & {
    budget?: Pick<ContextBudget, 'tokenThreshold' | 'systemPromptTokens'>;
    fixedCap?: number;
  }
): ProviderMessage[] {
  const { budget, fixedCap, unitsOut, ...rest } = args;
  // Each attempt writes into its own units array; the kept attempt's units are copied into the
  // caller's `unitsOut`. If we passed `unitsOut` straight through, a second (shrunk) assembly
  // would append to or duplicate the first attempt's units — the returned units must correspond
  // exactly to the returned assembly.
  const runOnce = (
    runTokenCap: number
  ): { messages: ProviderMessage[]; units: ReplayUnitSpan[] } => {
    const localUnits: ReplayUnitSpan[] = [];
    const messages = assembleAgentPayload({ ...rest, runTokenCap, unitsOut: localUnits });
    return { messages, units: localUnits };
  };
  const commit = (result: {
    messages: ProviderMessage[];
    units: ReplayUnitSpan[];
  }): ProviderMessage[] => {
    if (unitsOut) {
      unitsOut.length = 0;
      for (const u of result.units) unitsOut.push(u);
    }
    return result.messages;
  };
  if (fixedCap) return commit(runOnce(fixedCap));
  if (!budget) return commit(runOnce(DEFAULT_REPLAY_RUN_TOKEN_CAP));
  const floor = DEFAULT_REPLAY_RUN_TOKEN_CAP;
  const ceiling = replayRunCapCeiling(budget.tokenThreshold, floor);
  const first = runOnce(ceiling);
  const cap = shrinkReplayRunCap({
    ceiling,
    floor,
    freeTokens: budget.tokenThreshold - budget.systemPromptTokens,
    totalTokens: estimateReplayTokens(first.messages),
  });
  return commit(cap === ceiling ? first : runOnce(cap));
}

/**
 * The newest `(created_at, id)` keyset among the message rows a replay consumed.
 * Structurally compatible with the voice catch-up cursor: seeding the catch-up
 * watermark from THIS (rather than a second `getLastByThread` read after
 * assembly) makes the assembled context and the catch-up window provably
 * contiguous — no row can slip through the gap between two reads.
 */
export interface ReplayWatermark {
  readonly createdAt: string;
  readonly id: string;
}

export interface ReplayPayload {
  readonly messages: ProviderMessage[];
  /**
   * Where each replay unit (a user message, a run, a peer message) ends in `messages`, in order.
   * Fold planning cuts only at these, so a fold never splits a run's tool exchange.
   */
  readonly units: ReplayUnitSpan[];
  /** The compaction replay applied (its summary is the first message), or null. */
  readonly compaction: CompactionRecord | null;
  /** Null only when the thread had zero message rows at read time. */
  readonly watermark: ReplayWatermark | null;
}

/**
 * Normalized rows behind one replay read. Summary generation reuses this
 * source so compaction sees the same agent-private projection as a live turn
 * without reimplementing replay/privacy rules.
 */
export interface ReplaySource {
  readonly messageRows: MessageRow[];
  readonly messages: ReplayMessageRow[];
  readonly runs: ReplayRun[];
  readonly activityByRun: Map<string, ReplayActivityRow[]>;
  readonly watermark: ReplayWatermark | null;
}

export async function loadReplaySource(
  threadId: string,
  preloadedMessageRows?: MessageRow[]
): Promise<ReplaySource> {
  const [msgRows, runRows, activityRows] = await Promise.all([
    preloadedMessageRows ?? Messages.listByThreadId(threadId),
    Runs.listByThreadId(threadId),
    AgentActivityLog.getByThreadId(threadId),
  ]);

  return normalizeReplaySource(msgRows, runRows, activityRows);
}

/** Display names for every teammate who spoke in the thread, by agent id. */
async function loadTeammateNames(
  messages: readonly ReplayMessageRow[],
  perceivingAgentId: string
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.agentId && m.agentId !== perceivingAgentId) ids.add(m.agentId);
  }
  const names = new Map<string, string>();
  await Promise.all(
    [...ids].map(async (id) => {
      try {
        const name = (await Agents.findById(id))?.name?.trim();
        if (name) names.set(id, name);
      } catch (err) {
        // A missing name falls back to the agent id; the label still identifies the speaker.
        logger.warn(`[replay] teammate name lookup failed for ${id}: ${getErrorMessage(err)}`);
      }
    })
  );
  return names;
}

/**
 * Display names for the people who spoke, by user id — only for a group thread
 * (more than one agent, or more than one person), where it matters who said
 * what. Undefined for a 1:1 thread, which leaves human messages plain.
 */
async function loadPeopleNamesForGroup(
  threadId: string,
  messages: readonly ReplayMessageRow[]
): Promise<Map<string, string> | undefined> {
  let isGroup = false;
  try {
    const participants = await ThreadParticipants.listByThread(threadId);
    isGroup =
      participants.filter((p) => p.agentId).length > 1 ||
      participants.filter((p) => p.userId).length > 1;
  } catch (err) {
    // Without the roster the thread is treated as 1:1: human messages stay plain.
    logger.warn(`[replay] participant lookup failed for ${threadId}: ${getErrorMessage(err)}`);
    return undefined;
  }
  if (!isGroup) return undefined;

  const ids = new Set<string>();
  for (const m of messages) if (m.userId && m.role === 'user') ids.add(m.userId);
  const names = new Map<string, string>();
  await Promise.all(
    [...ids].map(async (id) => {
      try {
        const name = (await Users.findById(id))?.name?.trim();
        if (name) names.set(id, name);
      } catch (err) {
        // A missing name falls back to "user"; the label still marks a person speaking.
        logger.warn(`[replay] user name lookup failed for ${id}: ${getErrorMessage(err)}`);
      }
    })
  );
  return names;
}

export async function buildReplayPayload(
  threadId: string,
  perceivingAgentId: string,
  /**
   * The window this replay will be sent into; omitted, the fixed per-run cap applies and no
   * newcomer cut is planned (the cut needs the declared window).
   */
  budget?: Pick<ContextBudget, 'tokenThreshold' | 'systemPromptTokens'> &
    Partial<Pick<ContextBudget, 'contextWindowTokens'>>,
  /**
   * Persists a newcomer cut as the agent's own compaction so later turns replay from it. Omitted
   * (the usage estimate), the cut is still applied to this payload but not saved.
   */
  onNewcomerCut?: (record: CompactionRecord) => Promise<void>
): Promise<ReplayPayload> {
  const source = await loadReplaySource(threadId);

  // The newest persisted compaction for this agent: units up to its cut are represented by its
  // summary. A lookup that fails replays in full; the turn must not depend on it.
  let compaction = await loadLatestCompaction(threadId, perceivingAgentId).catch((err) => {
    logger.warn(`[replay] compaction lookup failed for ${threadId}: ${getErrorMessage(err)}`);
    return null;
  });
  const assembleArgs = {
    perceivingAgentId,
    runs: source.runs,
    messages: source.messages,
    activityByRun: source.activityByRun,
    fixedCap: resolveFixedReplayRunTokenCap(),
    budget,
    agentNames: await loadTeammateNames(source.messages, perceivingAgentId),
    userNames: await loadPeopleNamesForGroup(threadId, source.messages),
  };
  let units: ReplayUnitSpan[] = [];
  let assembled = assembleWithScaledCap({
    ...assembleArgs,
    ...(compaction ? { compaction } : {}),
    unitsOut: units,
  });

  // An agent new to the thread (no fold, no run of its own) replays only the newest units that
  // fit a share of its window, behind a note. It never summarizes what it missed and never
  // borrows another agent's fold; the cut becomes its own compaction, so the next turn replays
  // from it and folds normally from there.
  const isNewcomer = !source.runs.some((run) => run.agentId === perceivingAgentId);
  if (!compaction && isNewcomer && budget?.contextWindowTokens) {
    const plan = planNewcomerCut({
      messages: assembled,
      units,
      capTokens: newcomerTailCap(budget.contextWindowTokens),
    });
    if (plan) {
      compaction = {
        through: plan.through,
        summary: newcomerCutNote(plan.omittedUnits, plan.through.startAt),
        carryForward: null,
        foldedUnits: plan.omittedUnits,
        cut: true,
      };
      if (onNewcomerCut) {
        try {
          await onNewcomerCut(compaction);
        } catch (err) {
          // The cut still shapes this payload; without the row the next turn plans it again.
          logger.warn(
            `[replay] newcomer cut was not saved for ${threadId}: ${getErrorMessage(err)}`
          );
        }
      }
      units = [];
      assembled = assembleWithScaledCap({ ...assembleArgs, compaction, unitsOut: units });
    }
  }

  // One explanatory legend per assembled batch (never per message) — attached
  // here, outside the pure assembly, right before the payload ships.
  return {
    messages: attachRelayedLegend(assembled),
    units,
    compaction,
    watermark: source.watermark,
  };
}

function newcomerCutNote(omittedUnits: number, firstOmittedStartAt: string): string {
  const turns = omittedUnits === 1 ? '1 earlier turn' : `${omittedUnits} earlier turns`;
  return `You joined this thread after ${turns} (the first from ${firstOmittedStartAt}). They are not shown; the conversation below starts after them.`;
}

function normalizeReplaySource(
  msgRows: MessageRow[],
  runRows: Awaited<ReturnType<typeof Runs.listByThreadId>>,
  activityRows: Awaited<ReturnType<typeof AgentActivityLog.getByThreadId>>
): ReplaySource {
  // Max keyset over the exact rows this assembly read. Computed explicitly (not
  // "last element") so it is correct regardless of listByThreadId's ordering,
  // which sorts by created_at only — no id tiebreaker among equal timestamps.
  let watermark: ReplayWatermark | null = null;
  for (const m of msgRows) {
    if (
      !watermark ||
      m.createdAt > watermark.createdAt ||
      (m.createdAt === watermark.createdAt && m.id > watermark.id)
    ) {
      watermark = { createdAt: m.createdAt, id: m.id };
    }
  }

  // The run-ended footer is UI-only narration: kept out of the replayed messages
  // (agent context, summary input) but still counted in the watermark above, so
  // the voice catch-up cursor stays contiguous with the rows this read consumed.
  const messages: ReplayMessageRow[] = msgRows
    .filter((m) => !isAgentRunEndedRow(m))
    .map((m) => ({
      id: m.id,
      agentId: m.agentId,
      role: m.role as 'user' | 'assistant',
      content: m.content,
      runId: m.runId ?? null,
      createdAt: m.createdAt,
      injectedDuringRun: m.injectedDuringRun,
      externalSenderLabel: m.externalSenderLabel ?? null,
      originalAgentName: readOriginalAgentName(m.metadata),
      // Trust discriminators for the relayed-content guard: a userId marks a
      // human-authored row; 'thread_event' marks server narration. Both render
      // plain — only genuinely untrusted relays get framed.
      userId: m.userId ?? null,
      messageType: m.messageType ?? null,
      // Agent-private gate: buildReplay skips this row for any perceiver
      // other than the target. NULL for every normal message.
      visibleToAgentId: m.visibleToAgentId ?? null,
    }));

  const runs: ReplayRun[] = runRows.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    status: r.status,
    error: r.error,
  }));

  const activityByRun = new Map<string, ReplayActivityRow[]>();
  for (const a of activityRows) {
    if (!a.runId) continue;
    // A generated summary is logged for the UI, not called by the agent.
    if (isSummaryBookkeepingActivity(a)) continue;
    const list = activityByRun.get(a.runId);
    const row: ReplayActivityRow = {
      id: a.id,
      runId: a.runId,
      actionType: a.actionType,
      content: a.content,
      tool: a.tool,
      toolInput: a.toolInput,
      toolOutput: a.toolOutput,
      createdAt: a.createdAt,
    };
    if (list) list.push(row);
    else activityByRun.set(a.runId, [row]);
  }

  return { messageRows: msgRows, messages, runs, activityByRun, watermark };
}
