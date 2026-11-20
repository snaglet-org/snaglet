import type {
  ToolConfirmationDecision,
  ToolConfirmationRequestPayload,
} from '@snaglet/shared/types';
import {
  grantHelperTool,
  resolveHelperToolPolicy,
} from '@server/services/subagents/helperInheritance';
import { ThreadParticipants } from '@snaglet/db';
import { appendAgentToolAllowList } from '@server/services/agentToolAllowList';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { notifyToolApprovalAsk, type AskNotification } from '@server/services/askNotifications';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import { announceAsk, announceAskSettled } from './askFeed';
import { wsService } from '../WebSocketService';

export interface ConfirmationResult {
  approved: boolean;
  timedOut: boolean;
  /** A persistent allow-list choice was written successfully. */
  policyUpdated?: boolean;
}

interface PendingToolConfirmation {
  payload: ToolConfirmationRequestPayload;
  allowListSnapshot: string[];
  denyListSnapshot: string[];
  resolving: boolean;
  settle: (result: ConfirmationResult) => void;
  /** Settle unapproved and tell the pane the prompt is gone (Stop, reaper). */
  close: () => void;
  /** The feed notification announcing this prompt; dismissed when it settles. */
  notification?: AskNotification;
}

export interface WaitForConfirmationInput {
  threadId: string;
  sessionId: string;
  callId: string;
  agentId?: string;
  /** The run that is waiting, recorded on the prompt's notification. */
  runId?: string | null;
  toolName: string;
  toolInput: Record<string, unknown>;
  mode?: 'approval' | 'allow_list';
  allowListSnapshot?: string[];
  denyListSnapshot?: string[];
  abortSignal?: AbortSignal;
}

const CONFIRMATION_TIMEOUT_MS = 60_000;
const MAX_INPUT_SUMMARY_CHARS = 2_000;
const pendingByThread = new Map<string, Map<string, PendingToolConfirmation>>();

function threadMap(threadId: string): Map<string, PendingToolConfirmation> {
  let map = pendingByThread.get(threadId);
  if (!map) {
    map = new Map();
    pendingByThread.set(threadId, map);
  }
  return map;
}

function drop(threadId: string, callId: string): void {
  const map = pendingByThread.get(threadId);
  if (!map) return;
  map.delete(callId);
  if (map.size === 0) pendingByThread.delete(threadId);
}

/** The string args a tool marks `confirmFullArgs` that this call fills in. */
function fullArgsOf(toolName: string, input: Record<string, unknown>): string[] {
  const keys = toolRegistry.getDefinition(toolName)?.confirmFullArgs ?? [];
  return keys.filter((key) => typeof input[key] === 'string');
}

/**
 * The prompt's view of the call: the input as JSON, capped, then each
 * `confirmFullArgs` arg in full and verbatim with its length, so the person
 * reads exactly the text that will be saved.
 */
function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  const full = fullArgsOf(toolName, input);
  const rest = Object.fromEntries(Object.entries(input).filter(([key]) => !full.includes(key)));
  let summary: string;
  try {
    summary = JSON.stringify(rest, null, 2);
  } catch {
    summary = '[Tool input could not be serialized]';
  }
  if (!summary) summary = '{}';
  if (summary.length > MAX_INPUT_SUMMARY_CHARS) {
    summary = `${summary.slice(0, MAX_INPUT_SUMMARY_CHARS)}\n… (truncated)`;
  }
  for (const key of full) {
    const value = input[key] as string;
    summary += `\n\n${key} (${value.length} characters, in full):\n${value}`;
  }
  return summary;
}

/**
 * Park a tool call until a user approves/denies it. Pending requests are keyed
 * by thread rather than socket session so a reloaded pane can recover and
 * answer the same request after session:resume.
 *
 * Every prompt is also a notification (askNotifications), dismissed on each
 * way the prompt settles: a decision (including a rejected or unpersisted
 * one), the timeout, the run's abort, and cancelToolConfirmationsForThread.
 * All of them run through `settle` -> `cleanup`. The three that end a prompt
 * nobody answered (the timeout, the abort, the cancel) also send
 * socket:tool:confirmation_timeout so the pane closes its Approve/Deny panel.
 */
export function waitForConfirmation(input: WaitForConfirmationInput): Promise<ConfirmationResult> {
  return new Promise<ConfirmationResult>((resolve) => {
    activeRunTracker.noteProgressForThread(input.threadId);

    const payload: ToolConfirmationRequestPayload = {
      threadId: input.threadId,
      sessionId: input.sessionId,
      callId: input.callId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      toolName: input.toolName,
      mode: input.mode ?? 'approval',
      inputSummary: summarizeToolInput(input.toolName, input.toolInput),
    };

    let settled = false;
    let notification: AskNotification | null = null;
    const cleanup = (): void => {
      announceAskSettled(input.callId);
      drop(input.threadId, input.callId);
      clearTimeout(timeout);
      input.abortSignal?.removeEventListener('abort', onAbort);
      void notification?.settle();
    };
    const settle = (result: ConfirmationResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const announceClosed = (): void => {
      wsService.broadcastToChannel(input.threadId, {
        type: 'socket:tool:confirmation_timeout',
        payload: {
          threadId: input.threadId,
          callId: input.callId,
          toolName: input.toolName,
        },
      });
    };
    // Stop or a reaper cancel ends a prompt that is on screen: close the
    // pane's panel (once — a prompt that already settled is left alone), then
    // unblock the run. The run, not this module, records the call as canceled.
    const close = (): void => {
      if (settled) return;
      announceClosed();
      settle({ approved: false, timedOut: false });
    };
    const onAbort = (): void => close();
    const timeout = setTimeout(() => {
      logger.warn(
        `[tool:confirm] Confirmation timed out after ${CONFIRMATION_TIMEOUT_MS / 1000}s ` +
          `[session=${input.sessionId}] [tool=${input.toolName}] [callId=${input.callId}]`,
        {
          sessionId: input.sessionId,
          threadId: input.threadId,
          toolName: input.toolName,
          callId: input.callId,
          eventType: 'tool_confirmation_timeout',
        }
      );
      announceClosed();
      settle({ approved: false, timedOut: true });
    }, CONFIRMATION_TIMEOUT_MS);

    const entry: PendingToolConfirmation = {
      payload,
      allowListSnapshot: [...(input.allowListSnapshot ?? [])],
      denyListSnapshot: [...(input.denyListSnapshot ?? [])],
      resolving: false,
      settle,
      close,
    };
    threadMap(input.threadId).set(input.callId, entry);
    input.abortSignal?.addEventListener('abort', onAbort, { once: true });
    // Stopped before the prompt went out: there is no panel to close.
    if (input.abortSignal?.aborted) {
      settle({ approved: false, timedOut: false });
      return;
    }

    // Announced only once it is really shown: a run stopped before the prompt
    // went out (above) gets no notification.
    notification = notifyToolApprovalAsk({
      threadId: input.threadId,
      callId: input.callId,
      agentId: input.agentId,
      runId: input.runId,
      toolName: input.toolName,
      inputSummary: payload.inputSummary,
    });
    entry.notification = notification;

    const requestFrame = { type: 'socket:tool:confirmation_request', payload };
    wsService.broadcastToChannel(input.threadId, requestFrame);
    announceAsk(requestFrame);
  });
}

/** Resolve a pending confirmation. No-op if it already timed out or closed. */
export async function resolveToolConfirmation(
  threadId: string | undefined,
  callId: string | undefined,
  decision: ToolConfirmationDecision
): Promise<void> {
  if (!threadId || !callId) return;
  const pending = pendingByThread.get(threadId)?.get(callId);
  if (!pending || pending.resolving) return;
  pending.resolving = true;

  const validDecision =
    decision === 'deny' ||
    (pending.payload.mode === 'approval'
      ? decision === 'approve_once'
      : decision === 'allow_agent' || decision === 'allow_thread');
  if (!validDecision) {
    logger.warn('[tool:confirm] rejected decision that does not match confirmation mode', {
      threadId,
      callId,
      mode: pending.payload.mode,
      decision,
    });
    pending.settle({ approved: false, timedOut: false });
    return;
  }

  if (pending.payload.mode === 'allow_list' && decision !== 'deny') {
    const agentId = pending.payload.agentId;
    if (!agentId) {
      pending.settle({ approved: false, timedOut: false });
      return;
    }
    try {
      // A subagent helper inherits its orchestrator's permissions, so
      // its grant lands where the gap is (grantHelperTool), never on the
      // helper's hidden thread.
      const helperPolicy =
        decision === 'allow_agent' || decision === 'allow_thread'
          ? await resolveHelperToolPolicy(agentId)
          : null;
      if (helperPolicy && (decision === 'allow_agent' || decision === 'allow_thread')) {
        await grantHelperTool(helperPolicy, agentId, pending.payload.toolName, decision);
      } else if (decision === 'allow_agent') {
        const updated = await appendAgentToolAllowList(agentId, pending.payload.toolName);
        if (!updated) throw new Error(`Agent not found: ${agentId}`);
      } else if (decision === 'allow_thread') {
        const updated = await ThreadParticipants.grantToolAccess(
          threadId,
          agentId,
          pending.payload.toolName,
          pending.allowListSnapshot,
          pending.denyListSnapshot
        );
        if (!updated) throw new Error(`Agent ${agentId} is not a participant in ${threadId}`);
      }
    } catch (err) {
      logger.error('[tool:confirm] failed to persist allow-list decision', {
        threadId,
        callId,
        agentId,
        toolName: pending.payload.toolName,
        decision,
        error: getErrorMessage(err),
      });
      pending.settle({ approved: false, timedOut: false });
      return;
    }
  }

  pending.settle({
    approved: decision !== 'deny',
    timedOut: false,
    ...(decision === 'allow_agent' || decision === 'allow_thread' ? { policyUpdated: true } : {}),
  });
}

/** Rehydrate still-pending confirmation panels after a socket session resume. */
export function listPendingToolConfirmations(threadId: string): ToolConfirmationRequestPayload[] {
  return Array.from(pendingByThread.get(threadId)?.values() ?? [], (entry) => entry.payload);
}

/**
 * Abort/reaper reconciliation: unblock every confirmation parked on a thread
 * and close each one's panel (socket:tool:confirmation_timeout).
 */
export function cancelToolConfirmationsForThread(threadId: string): number {
  const entries = Array.from(pendingByThread.get(threadId)?.values() ?? []);
  for (const entry of entries) entry.close();
  return entries.length;
}

/** Every still-pending confirmation across all threads (the global ask feed's snapshot). */
export function listAllPendingToolConfirmations(): ToolConfirmationRequestPayload[] {
  return Array.from(pendingByThread.values()).flatMap((map) =>
    Array.from(map.values(), (entry) => entry.payload)
  );
}
