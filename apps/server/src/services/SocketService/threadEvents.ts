/**
 * threadEvents: append-only narration of thread state (roster, models, dispatch
 * mode, "thread started"). These live as author-less `thread_event` message rows,
 * not in the system prompt, so a state change never busts the prompt-cache prefix.
 * `thread_participants` stays the source of truth; emission is best-effort and
 * must never break the mutation that triggered it. Each emitter persists the line, broadcasts `socket:chat:message_created`, and
 * hands the same line to any agent running in the thread via the mid-run pending
 * queue (reason 'system'), so a long turn does not finish under stale state.
 */

import { AGENT_RUN_ENDED_EVENT_KIND } from './agentRunEnded';
import { Messages } from '@snaglet/db/tables/messages';
import { Agents } from '@snaglet/db/tables/agents';
import { wsService } from '@server/services/WebSocketService';
import { logger } from '@server/config/logger';
import { getErrorMessage, isoNow, isoStamp } from '@snaglet/shared/utils';
import { CONVERSATION_STOP_REASON_COPY, type ConversationStopReason } from '@snaglet/shared/types';
import { activeWorkRegistry } from '@server/services/ActiveWorkRegistry';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';

export type DispatchMode = 'all' | 'mentioned';

/** Vision access grants; mirrors VisionCaptureSource without importing it. */
export type VisionModeSource = 'screen' | 'camera' | 'both';

/** Attribution shown on a mid-run-injected thread event. Not a principal. */
const THREAD_EVENT_SENDER_NAME = 'thread state';

/** Kind tags stashed on metadata.event_kind (idempotency + observability). */
export const THREAD_EVENT_KIND = {
  started: 'thread_started',
  participantAdded: 'participant_added',
  participantRemoved: 'participant_removed',
  modelChanged: 'model_changed',
  dispatchModeChanged: 'dispatch_mode_changed',
  voiceModeEnabled: 'voice_mode_enabled',
  voiceModeDisabled: 'voice_mode_disabled',
  visionModeEnabled: 'vision_mode_enabled',
  visionModeSourceChanged: 'vision_mode_source_changed',
  visionModeDisabled: 'vision_mode_disabled',
  maxWavesChanged: 'max_waves_changed',
  conversationBudgetChanged: 'conversation_budget_changed',
  runTimeLimitChanged: 'run_time_limit_changed',
  agentRunEnded: AGENT_RUN_ENDED_EVENT_KIND,
  conversationEnded: 'conversation_ended',
  summaryModelUnavailable: 'summary_model_unavailable',
  unattendedToolCall: 'unattended_tool_call',
} as const;

/**
 * Stable line prefixes for each narration format. Single source of truth used
 * both to build each event line (below) and to detect replayed thread_event
 * lines downstream (ContextWindowService.isConversationalUserMessage), so the
 * detector matches documented markers instead of duplicating strings. Each
 * prefix must remain an exact prefix of the content the matching emitter
 * produces.
 */
export const THREAD_EVENT_LINE_PREFIX = {
  started: '[thread started',
  participantAdded: '[participant added',
  participantRemoved: '[participant removed',
  modelChanged: '[participant model changed',
  dispatchModeChanged: '[dispatch mode changed',
  // One prefix covers both the enabled + disabled voice lines. Registered so
  // ContextWindowService.isConversationalUserMessage classifies voice toggles as
  // narration (folded/ignored), exactly like the roster/mode events.
  voiceMode: '[voice mode',
  // One prefix covers enabled / source-changed / disabled, mirroring voice.
  visionMode: '[vision mode',
  maxWavesChanged: '[max dispatch waves changed',
  conversationBudgetChanged: '[conversation budget changed',
  runTimeLimitChanged: '[run time limit changed',
  agentRunEnded: '[agent run ended',
  conversationEnded: '[conversation ended',
  // One prefix covers both halt shapes (never configured / configured but
  // failing) and the clearing line.
  summaryModelUnavailable: '[summary model',
  // One prefix covers both outcomes (auto-approved / skipped).
  unattendedToolCall: '[unattended]',
  // Nothing emits this line, but older databases still hold rows with it and
  // they replay as plain user text. Listed so compression classifies them as
  // narration rather than as the active user request. Never build a line with it.
  watchedChangesPending: '[watched changes',
} as const;

/** All thread_event line prefixes, for prefix-scanning replayed lines. */
export const THREAD_EVENT_LINE_PREFIXES: readonly string[] =
  Object.values(THREAD_EVENT_LINE_PREFIX);

/** Dynamic actor/target names prevent the abort narration from having a fixed prefix. */
export const THREAD_EVENT_ABORT_LINE_PATTERN = /^\[[^\]]+\] aborted \[[^\]]+\]$/;

/**
 * Hand a just-persisted narration line to every agent running in this thread
 * now, so a state change during a long turn reaches it before its next wake.
 * Targets come from the active-work registry, deduped per agent. An agent with no
 * run in flight is skipped: it reads the same line from replay, and queueing
 * would show the event twice. The queued line is byte-identical to the row.
 */
function injectIntoRunningAgents(threadId: string, content: string, eventKind: string): void {
  try {
    const targeted = new Set<string>();
    for (const item of activeWorkRegistry.snapshot()) {
      if (item.kind !== 'thread-run' || item.threadId !== threadId) continue;
      const agentId = item.agentId;
      if (!agentId || targeted.has(agentId)) continue;
      targeted.add(agentId);
      pendingAgentMessages.enqueue({
        threadId,
        targetAgentId: agentId,
        senderName: THREAD_EVENT_SENDER_NAME,
        content,
        reason: 'system',
      });
    }
  } catch (err) {
    logger.warn(`[thread-events] failed to inject ${eventKind} mid-run: ${getErrorMessage(err)}`);
  }
}

async function persistAndBroadcast(
  threadId: string,
  content: string,
  eventKind: string,
  /**
   * `injectMidRun: false` persists + broadcasts without handing the line to
   * agents currently running (see injectIntoRunningAgents). Only for narration
   * that a running agent is already being told another way this same turn —
   * every state change wants the default (inject), or an agent mid-turn would
   * finish under state that changed underneath it.
   */
  opts: { injectMidRun?: boolean } = {}
): Promise<void> {
  try {
    // Deliberately no syncMessageEmbedding call here — thread_event rows are
    // machine narration, not retrieval-worthy content (see
    // EmbeddingNodeClassifier's 'message' case, which requires
    // message_type = 'message' and would exclude these anyway). Do not add one.
    const row = await Messages.createEvent({ threadId, content, eventKind });
    wsService.broadcastToChannel(threadId, {
      type: 'socket:chat:message_created',
      payload: {
        id: row.id,
        threadId,
        role: 'user',
        content,
        // UTC on the wire, like live user messages (the row reads back with an offset).
        created_at: row.createdAt ? isoStamp(row.createdAt) : isoNow(),
        message_type: 'thread_event',
      },
    });
    if (opts.injectMidRun !== false) injectIntoRunningAgents(threadId, content, eventKind);
  } catch (err) {
    logger.warn(`[thread-events] failed to emit ${eventKind}: ${getErrorMessage(err)}`);
  }
}

/** Resolve an agent id to a display name, falling back to the id. */
async function agentName(agentId: string): Promise<string> {
  try {
    const agent = await Agents.findById(agentId);
    return agent?.name?.trim() || agentId;
  } catch {
    return agentId;
  }
}

/**
 * Turn-zero event: one "[thread started …]" line the first time a thread
 * dispatches. Idempotent, so it is safe to call on every dispatch. Captures the
 * roster + dispatch mode so a later compaction still has a snapshot to carry.
 *
 * A participant without a known name is looked up by id here, after the
 * idempotency check: dispatch names participants only in group threads, so a
 * lone agent would otherwise show its id.
 */
export async function emitThreadStartedEvent(
  threadId: string,
  opts: {
    participants: ReadonlyArray<{ agentId: string; name?: string }>;
    /** null for a DM / home thread: no routing, so no mode is named. */
    dispatchMode: DispatchMode | null;
  }
): Promise<void> {
  try {
    if (await Messages.hasEventOfKind(threadId, THREAD_EVENT_KIND.started)) return;
    const names = await Promise.all(
      opts.participants.map((p) => p.name?.trim() || agentName(p.agentId))
    );
    const roster = names.length > 0 ? names.join(', ') : '(none yet)';
    const mode = opts.dispatchMode ? ` · mode: ${opts.dispatchMode}` : '';
    const content = `${THREAD_EVENT_LINE_PREFIX.started} · participants: ${roster}${mode}]`;
    await persistAndBroadcast(threadId, content, THREAD_EVENT_KIND.started);
  } catch (err) {
    logger.warn(`[thread-events] emitThreadStartedEvent failed: ${getErrorMessage(err)}`);
  }
}

/** A participant (agent) joined the thread. */
export async function emitParticipantAddedEvent(
  threadId: string,
  agentId: string,
  nameHint?: string
): Promise<void> {
  const name = nameHint?.trim() || (await agentName(agentId));
  await persistAndBroadcast(
    threadId,
    `${THREAD_EVENT_LINE_PREFIX.participantAdded} · ${name} joined the thread]`,
    THREAD_EVENT_KIND.participantAdded
  );
}

/** A participant (agent) left the thread. */
export async function emitParticipantRemovedEvent(
  threadId: string,
  agentId: string,
  nameHint?: string
): Promise<void> {
  const name = nameHint?.trim() || (await agentName(agentId));
  await persistAndBroadcast(
    threadId,
    `${THREAD_EVENT_LINE_PREFIX.participantRemoved} · ${name} left the thread]`,
    THREAD_EVENT_KIND.participantRemoved
  );
}

export interface ThreadEventModelIdentity {
  providerId: string;
  modelId: string;
}

function modelLabel(model: ThreadEventModelIdentity | null): string {
  return model ? `${model.providerId}/${model.modelId}` : '(not configured)';
}

/** A participant's effective provider/model changed for this thread. */
export async function emitModelChangedEvent(
  threadId: string,
  agentId: string,
  previousModel: ThreadEventModelIdentity | null,
  nextModel: ThreadEventModelIdentity | null
): Promise<void> {
  const name = await agentName(agentId);
  await persistAndBroadcast(
    threadId,
    `${THREAD_EVENT_LINE_PREFIX.modelChanged} · ${name} · from: ${modelLabel(previousModel)} · to: ${modelLabel(nextModel)}]`,
    THREAD_EVENT_KIND.modelChanged
  );
}

/** The thread's dispatch (routing) mode changed. */
export async function emitDispatchModeChangedEvent(
  threadId: string,
  mode: DispatchMode
): Promise<void> {
  await persistAndBroadcast(
    threadId,
    `${THREAD_EVENT_LINE_PREFIX.dispatchModeChanged} · now: ${mode}]`,
    THREAD_EVENT_KIND.dispatchModeChanged
  );
}

/**
 * The actionable half of the voice "enabled" line: what an agent reading it
 * mid-run should do. Replies are synthesized by the session's own TTS sink, so
 * speaking is not a tool call; shell `say` and `text_to_speech` bypass that sink
 * and would contradict VOICE_PROFILE_BLOCK. Kept to one compact line because it
 * replays on every future turn.
 */
const VOICE_ENABLED_HINT =
  'your replies are spoken automatically — just reply, 1-3 sentences; do not play speech yourself (shell say, text_to_speech)';

/**
 * Voice mode toggled on for the thread. The durable state fact (agents waking
 * later know voice is on); the per-turn speaking behavior rides the ephemeral
 * turn-context tail, never this event (persisted behavior rules go stale across
 * toggles — see composeTurnContextTail / VOICE_PROFILE_BLOCK).
 */
export async function emitVoiceModeEnabledEvent(threadId: string): Promise<void> {
  await persistAndBroadcast(
    threadId,
    `${THREAD_EVENT_LINE_PREFIX.voiceMode} enabled · ${VOICE_ENABLED_HINT}]`,
    THREAD_EVENT_KIND.voiceModeEnabled
  );
}

/** Voice mode toggled off for the thread. */
export async function emitVoiceModeDisabledEvent(threadId: string): Promise<void> {
  await persistAndBroadcast(
    threadId,
    `${THREAD_EVENT_LINE_PREFIX.voiceMode} disabled]`,
    THREAD_EVENT_KIND.voiceModeDisabled
  );
}

/**
 * The capture tool a granted vision source actually unlocks. Ids and call
 * shapes are the registered definitions: `capture_user_screen` and
 * `capture_user_camera` both take no arguments (`properties: {}`,
 * additionalProperties false). `screenshot` is deliberately absent — it renders
 * a URL, not the user's screen — and `vision_mode` is the toggle itself, not
 * the way to look.
 */
const VISION_CAPTURE_HINT: Record<VisionModeSource, string> = {
  screen: 'call capture_user_screen({})',
  camera: 'call capture_user_camera({})',
  both: 'call capture_user_screen({}) or capture_user_camera({})',
};

function visionHint(source: VisionModeSource): string {
  return `${VISION_CAPTURE_HINT[source]} only when you need to look — one frame per turn`;
}

/**
 * Vision access changed for the thread: the durable state fact, like the voice
 * pair above. Per-turn behavior text (which capture tool this agent can reach)
 * stays on the ephemeral turn-context tail via composeVisionAccessSegment; the
 * hint here is only the always-true call shape.
 *
 * One call covers enable / source change / disable, and is a no-op when the
 * source did not change, so a repeated `start` never narrates.
 */
export async function emitVisionModeChangedEvent(
  threadId: string,
  previousSource: VisionModeSource | null,
  nextSource: VisionModeSource | null
): Promise<void> {
  if (previousSource === nextSource) return;
  const prefix = THREAD_EVENT_LINE_PREFIX.visionMode;
  if (nextSource === null) {
    // No hint on a revocation — there is nothing to call.
    await persistAndBroadcast(
      threadId,
      `${prefix} disabled]`,
      THREAD_EVENT_KIND.visionModeDisabled
    );
    return;
  }
  if (previousSource === null) {
    await persistAndBroadcast(
      threadId,
      `${prefix} enabled · source: ${nextSource} · ${visionHint(nextSource)}]`,
      THREAD_EVENT_KIND.visionModeEnabled
    );
    return;
  }
  await persistAndBroadcast(
    threadId,
    `${prefix} source changed · from: ${previousSource} · to: ${nextSource} · ${visionHint(nextSource)}]`,
    THREAD_EVENT_KIND.visionModeSourceChanged
  );
}

/**
 * Render `threads.max_waves` for humans and models. The column is three-state
 * by design: NULL = fall back to the settings default, -1 = genuinely
 * unbounded, N > 0 = cap at exactly N. Naming the sentinel rather than printing
 * `-1` keeps the line readable without the reader knowing the encoding.
 */
function waveCapLabel(value: number | null): string {
  if (value === null) return 'default';
  if (value === -1) return 'unbounded';
  return String(value);
}

/** The thread's max dispatch waves changed. */
export async function emitMaxWavesChangedEvent(
  threadId: string,
  previous: number | null,
  next: number | null
): Promise<void> {
  await persistAndBroadcast(
    threadId,
    `${THREAD_EVENT_LINE_PREFIX.maxWavesChanged} · from: ${waveCapLabel(previous)} · to: ${waveCapLabel(next)}]`,
    THREAD_EVENT_KIND.maxWavesChanged
  );
}

/** The thread's conversation output-token budget changed. NULL = settings default. */
export async function emitConversationBudgetChangedEvent(
  threadId: string,
  previous: number | null,
  next: number | null
): Promise<void> {
  const label = (value: number | null): string => (value === null ? 'default' : String(value));
  await persistAndBroadcast(
    threadId,
    `${THREAD_EVENT_LINE_PREFIX.conversationBudgetChanged} · output tokens · from: ${label(previous)} · to: ${label(next)}]`,
    THREAD_EVENT_KIND.conversationBudgetChanged
  );
}

/** Compact duration copy matching the units the settings control offers. */
function durationLabel(seconds: number | null): string {
  if (seconds === null) return 'unlimited';
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/**
 * A participant's run time limit changed (`thread_participants.max_duration_seconds`,
 * surfaced as "Run time limit" in thread settings).
 *
 * Worded as a plain setting change, not a promise: the column is stored and
 * editable but no runtime reader enforces it yet (see ConfigResolverService),
 * so the line must not tell an agent it will be cut off at that mark.
 */
export async function emitRunTimeLimitChangedEvent(
  threadId: string,
  agentId: string,
  previousSeconds: number | null,
  nextSeconds: number | null
): Promise<void> {
  const name = await agentName(agentId);
  await persistAndBroadcast(
    threadId,
    `${THREAD_EVENT_LINE_PREFIX.runTimeLimitChanged} · ${name} · from: ${durationLabel(previousSeconds)} · to: ${durationLabel(nextSeconds)}]`,
    THREAD_EVENT_KIND.runTimeLimitChanged
  );
}

/** Compact elapsed copy for a run: `4s`, `1m12s`, `2h3m`. */
function elapsedLabel(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}h` : `${hours}h${restMinutes}m`;
}

/**
 * One agent's turn finished, as a summary line for people:
 *
 *   [agent run ended · Nova · 1m12s · 7 tool calls]
 *
 * Kept out of every agent-facing payload: not injected mid-run, and replay /
 * summary input / thread_read drop it (see agentRunEnded.ts). There is no
 * run-started counterpart, and it is one line per logical turn (stats keyed by
 * thread + agent in ActiveRunTracker), so a provider fallback narrates once.
 */
export async function emitAgentRunEndedEvent(
  threadId: string,
  opts: { agentName: string; durationMs: number; toolCalls: number }
): Promise<void> {
  const calls = `${opts.toolCalls} tool call${opts.toolCalls === 1 ? '' : 's'}`;
  await persistAndBroadcast(
    threadId,
    `${THREAD_EVENT_LINE_PREFIX.agentRunEnded} · ${opts.agentName} · ${elapsedLabel(opts.durationMs)} · ${calls}]`,
    THREAD_EVENT_KIND.agentRunEnded,
    // UI-only: never handed to a running agent (and replay drops the row; see
    // agentRunEnded.ts). It is a duration/tool-count footer for people.
    { injectMidRun: false }
  );
}

/**
 * A run nobody is watching (an automation or a hook started it) met a tool
 * call that would ask a person, and did not wait (see unattendedGate.ts):
 *
 *   [unattended] skipped shell (run) · Nova · automation "Daily digest" · needs a person to confirm
 *   [unattended] auto-approved shell (run) · Nova · hook "nightly-backup"
 *
 * Not injected mid-run: the agent already got the outcome as that call's tool
 * result. It replays like other narration, so a later turn knows what happened.
 */
export async function emitUnattendedToolCallEvent(threadId: string, body: string): Promise<void> {
  await persistAndBroadcast(
    threadId,
    `${THREAD_EVENT_LINE_PREFIX.unattendedToolCall} ${body}`,
    THREAD_EVENT_KIND.unattendedToolCall,
    { injectMidRun: false }
  );
}

/**
 * A dispatch conversation ended: persist why. One line per conversation, at run teardown:
 *
 *   [conversation ended · wave limit reached · waves: 6 · output tokens: 4210]
 *
 * The machine-readable reason rides both the row metadata (`stop_reason`) and
 * the broadcast payload, so the UI can style the line and decide whether to
 * show a "send a message to continue" affordance without parsing the copy.
 * Best-effort like every narration emitter — never breaks the run teardown.
 */
export async function emitConversationEndedEvent(
  threadId: string,
  opts: {
    stopReason: ConversationStopReason;
    waves: number;
    totalOutputTokens: number;
  }
): Promise<void> {
  try {
    const copy = CONVERSATION_STOP_REASON_COPY[opts.stopReason];
    const content =
      `${THREAD_EVENT_LINE_PREFIX.conversationEnded} · ${copy}` +
      ` · waves: ${opts.waves} · output tokens: ${opts.totalOutputTokens}]`;
    const row = await Messages.createEvent({
      threadId,
      content,
      eventKind: THREAD_EVENT_KIND.conversationEnded,
      metadata: {
        stop_reason: opts.stopReason,
        waves: opts.waves,
        total_output_tokens: opts.totalOutputTokens,
      },
    });
    wsService.broadcastToChannel(threadId, {
      type: 'socket:chat:message_created',
      payload: {
        id: row.id,
        threadId,
        role: 'user',
        content,
        created_at: row.createdAt ? isoStamp(row.createdAt) : isoNow(),
        message_type: 'thread_event',
        stop_reason: opts.stopReason,
      },
    });
  } catch (err) {
    logger.warn(`[thread-events] emitConversationEndedEvent failed: ${getErrorMessage(err)}`);
  }
}

/**
 * The thread's summary (compaction) model could not write a summary that was
 * owed, so the run was stopped and the thread is blocked (see summaryHalt).
 *
 * The line is the fix instruction, so it names the model and the reason rather
 * than saying "summarization failed": for a model id the provider has removed,
 * the repair is reading that id off this line and pointing the override at a
 * working model. Persisted like all narration, so it survives replay.
 */
export async function emitSummaryModelUnavailableEvent(
  threadId: string,
  opts: {
    /** 'model-failing' always names a model; 'not-configured' may (a missing credential). */
    kind: 'not-configured' | 'model-failing';
    model: ThreadEventModelIdentity | null;
    /** Human-readable detail: the provider error, the missing credential, … */
    reason: string;
    /** The halt's enumerated reason code; picks the line's cause and remedy. */
    cause?: string;
    agentName?: string | null;
  }
): Promise<void> {
  const who = opts.agentName ? ` · ${opts.agentName}` : '';
  const copy =
    opts.kind === 'model-failing'
      ? SUMMARY_MODEL_FAILING_COPY
      : ((opts.cause ? SUMMARY_MODEL_UNAVAILABLE_COPY[opts.cause] : undefined) ??
        SUMMARY_MODEL_NOT_CONFIGURED_COPY);
  const model = opts.model ? ` · ${modelLabel(opts.model)}` : '';
  const content =
    `${THREAD_EVENT_LINE_PREFIX.summaryModelUnavailable} ${copy.cause}${who}${model} · ${opts.reason}` +
    ` · run stopped and this thread is blocked until ${copy.until}]`;
  await persistAndBroadcast(threadId, content, THREAD_EVENT_KIND.summaryModelUnavailable);
}

interface SummaryModelUnavailableCopy {
  /** Follows "[summary model". */
  cause: string;
  /** Follows "blocked until". */
  until: string;
}

const SUMMARY_MODEL_FAILING_COPY: SummaryModelUnavailableCopy = {
  cause: 'failed',
  until: 'a working summary model is set',
};

const SUMMARY_MODEL_NOT_CONFIGURED_COPY: SummaryModelUnavailableCopy = {
  cause: 'not configured',
  until: 'a summary model is set',
};

/**
 * Not-configured halts whose cause is something other than a missing model.
 * The rest ('no-summary-model-configured', 'no-model-for-agent') read as
 * "not configured".
 */
const SUMMARY_MODEL_UNAVAILABLE_COPY: Readonly<Record<string, SummaryModelUnavailableCopy>> = {
  'no-credentials': {
    cause: 'credential unavailable',
    until: 'its credential is reconnected or another one is chosen',
  },
  'unsupported-provider': {
    cause: 'provider unsupported',
    until: 'a summary model on a supported provider is set',
  },
  'resolution-failed': {
    cause: 'could not be resolved',
    until: 'a working summary model is set',
  },
};

/** The blocked thread's summary model was repointed and the halt was lifted. */
export async function emitSummaryModelRestoredEvent(
  threadId: string,
  model: ThreadEventModelIdentity | null
): Promise<void> {
  await persistAndBroadcast(
    threadId,
    `${THREAD_EVENT_LINE_PREFIX.summaryModelUnavailable} restored · ${modelLabel(model)} · thread unblocked]`,
    THREAD_EVENT_KIND.summaryModelUnavailable
  );
}
