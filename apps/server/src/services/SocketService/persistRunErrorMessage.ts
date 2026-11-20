/**
 * persistRunErrorMessage — persist a system/error message into the thread
 * chat when an agent run fails mid-stream (or cannot start, as with no
 * model), and broadcast it so every participant (UI + other agents picking
 * up the thread next turn) can see what went wrong.
 *
 * Why this exists: prior to this helper, run failures only emitted
 * `socket:error` to the originating client. Other agents in the thread
 * had no record of the failure in their context, and any second browser
 * window watching the same thread saw a silent "Thinking…" bubble go
 * idle with no explanation. The UI shows error bubbles based on
 * `metadata.run_error` on a normal assistant message — same persistence
 * path used by every other message in the thread.
 *
 * Authorship: the failing agent's id is set as the message's `agent_id`,
 * with `role='assistant'` (the only DB CHECK-permitted author for a
 * non-user row). The `metadata.run_error` flag tells the UI to render
 * the bubble as an error instead of a regular agent reply, and the same
 * field travels into other agents' context windows so they know the
 * teammate hit a failure rather than just going quiet.
 *
 * Error text is sanitized via `summarizeError()` to strip stack traces,
 * filesystem paths, and provider tokens — the persisted content is what
 * the human sees in chat, so it must be safe to display verbatim.
 */

import { generateId, getErrorMessage, isoNow } from '@snaglet/shared/utils';
import type { RunErrorKind } from '@snaglet/shared/types';
import { Messages } from '@snaglet/db/tables/messages';
import { wsService } from '@server/services/WebSocketService';
import { LogsService } from '@server/services/LogsService';

export interface RunErrorContext {
  threadId: string;
  agentId: string;
  agentName: string;
  runId: string | null;
  kind: RunErrorKind;
  rawError: unknown;
  provider?: string | null;
  modelId?: string | null;
}

export interface PersistedRunError {
  messageId: string;
  summary: string;
  kind: RunErrorKind;
}

const STACK_LINE_RE = /^\s*at\s+.*/gm;
// Only treat a slash-run as a redactable filesystem path when it starts at a
// word boundary with a recognizable root (/Users, /home, /var, /tmp, /etc,
// /opt, /root) or is a bare absolute path beginning right after whitespace/
// start-of-string. This deliberately does not match provider identifiers
// like "someorg_a1b2/allenai/Molmo-7B-D-0924" that merely *contain*
// slashes — those aren't filesystem paths and must survive intact so the
// human can read (and act on) the actual endpoint name in the error.
const FS_PATH_RE = /(?:^|(?<=\s))\/(?:Users|home|var|tmp|etc|opt|root)(?:\/[A-Za-z0-9_.\-]+)*/g;
// Redact bearer-token-shaped strings, but never URLs themselves — a
// provider's "click here to fix this" link is the one actionable part of
// many error messages (e.g. Together's "start your endpoint" link) and must
// reach the user intact.
const TOKEN_LIKE_RE = /\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]+)\b/g;
const HOME_RE = /\/Users\/[^/\s]+/g;
const WHITESPACE_RE = /\s+/g;

const SUMMARY_MAX_CHARS = 400;

const HUMAN_KIND_LABEL: Record<RunErrorKind, string> = {
  timeout: 'Response timed out',
  model_failure: 'Model error',
  rate_limit: 'Rate limited',
  runtime: 'Run failed',
  aborted: 'Run aborted',
  no_model: 'No model configured',
  output_limit: 'Reply cut off',
};

/**
 * Strip stack traces, local filesystem paths, and token-shaped strings from
 * a raw error message; collapse whitespace; truncate. URLs are deliberately
 * left intact — a provider error's "visit this URL to fix it" link (e.g.
 * Together's "start your endpoint" link) is the one actionable part of the
 * message and must reach the user clickable. The result is what the human
 * sees in chat and what the next agent run will read out of message
 * history, so it must contain nothing sensitive (tokens, local home paths)
 * while still preserving anything actionable (URLs, provider identifiers).
 */
export function summarizeError(raw: unknown, kind: RunErrorKind): string {
  // `Error.name` is `'Error'` by default; only surface it when a subclass
  // populated something more useful (TypeError, AbortError, etc.). Empty
  // strings fall through to the post-sanitization fallback so the
  // kind-label takes over.
  const rawMsg =
    raw instanceof Error
      ? raw.message || (raw.name && raw.name !== 'Error' ? raw.name : '')
      : typeof raw === 'string'
        ? raw
        : '';

  let text = rawMsg
    .replace(STACK_LINE_RE, '')
    .replace(TOKEN_LIKE_RE, '[redacted]')
    .replace(HOME_RE, '~')
    .replace(FS_PATH_RE, '[path]')
    .replace(WHITESPACE_RE, ' ')
    .trim();

  if (text.length > SUMMARY_MAX_CHARS) {
    text = `${text.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
  }

  if (text.length === 0) text = HUMAN_KIND_LABEL[kind];
  return text;
}

/**
 * Best-effort classifier from a raw error to a `RunErrorKind`. Callers
 * usually already know the kind (the timeout branch knows it's a
 * timeout) — this is for paths where the failure shape is opaque.
 */
export function classifyRunError(raw: unknown): RunErrorKind {
  const msg = getErrorMessage(raw);
  const lower = msg.toLowerCase();
  // Stream-idle watchdog (ProviderStreamStallError): "Model stream stalled: …"
  // — checked first because the message also contains "model".
  if (lower.includes('stream stalled')) return 'timeout';
  if (lower.includes('timed out') || lower.includes('timeout')) return 'timeout';
  if (lower.includes('rate limit') || lower.includes('429')) return 'rate_limit';
  if (
    lower.includes('aborterror') ||
    lower.includes('aborted by user') ||
    lower.includes('user abort')
  ) {
    return 'aborted';
  }
  if (
    lower.includes(' 5') /* 5xx */ ||
    lower.includes('model') ||
    lower.includes('provider') ||
    lower.includes('overloaded')
  ) {
    return 'model_failure';
  }
  return 'runtime';
}

/**
 * Build the chat-visible body for the error bubble. Keeps the prose
 * short so it slots cleanly into agent context on the next turn; the
 * structured shape (kind, summary, provider, model) lives in
 * `metadata.run_error` for the UI.
 */
function buildErrorContent(ctx: RunErrorContext, summary: string): string {
  const label = HUMAN_KIND_LABEL[ctx.kind];
  const modelTag = ctx.provider && ctx.modelId ? ` (${ctx.provider}/${ctx.modelId})` : '';
  return `⚠ ${label}${modelTag}: ${summary}`;
}

/**
 * Persist the run-failure message + broadcast it to the thread channel.
 * Safe to call from any catch site; failures here are logged and
 * swallowed because losing the error bubble must never mask the
 * underlying error in caller logs.
 */
export async function persistRunErrorMessage(
  ctx: RunErrorContext
): Promise<PersistedRunError | null> {
  const summary = summarizeError(ctx.rawError, ctx.kind);
  const content = buildErrorContent(ctx, summary);
  const messageId = generateId('message');

  try {
    await Messages.create({
      id: messageId,
      threadId: ctx.threadId,
      role: 'assistant',
      agentId: ctx.agentId,
      content,
      messageType: 'message',
      runId: ctx.runId ?? null,
      injectedDuringRun: true,
      metadata: {
        run_error: {
          kind: ctx.kind,
          summary,
          provider: ctx.provider ?? null,
          model_id: ctx.modelId ?? null,
          agent_name: ctx.agentName,
        },
      },
    });

    wsService.broadcastToChannel(ctx.threadId, {
      type: 'socket:chat:message_created',
      payload: {
        id: messageId,
        threadId: ctx.threadId,
        role: 'assistant',
        content,
        agent_id: ctx.agentId,
        // Carry run_id so the client can scope this authoritative error row to
        // its run — it supersedes the transient `error:<agent>:<run>` bubble the
        // live socket:error frame paints (see useChatStream message_created).
        run_id: ctx.runId ?? null,
        created_at: isoNow(),
        message_type: 'message',
        injected_during_run: true,
        run_error: {
          kind: ctx.kind,
          summary,
          provider: ctx.provider ?? null,
          model_id: ctx.modelId ?? null,
          agent_name: ctx.agentName,
        },
      },
    });

    return { messageId, summary, kind: ctx.kind };
  } catch (err) {
    LogsService.warn('persistRunErrorMessage failed', {
      threadId: ctx.threadId,
      agentId: ctx.agentId,
      kind: ctx.kind,
      error: getErrorMessage(err),
    });
    return null;
  }
}
