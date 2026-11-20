/**
 * memoryExtraction — at compaction, a second utility-model call over the
 * folded span saves the few durable facts worth keeping. Agent-scoped facts
 * save as active memories with `verified = false`; member-scoped facts (about
 * the human) are only stored as `status = 'proposed'` until a person approves.
 * Best-effort, never throws; an unusable response is retried once, a parsed
 * array (even `[]`) is final. Keys are stable kebab-case with a kind prefix
 * (`connection-`, `user-`, `agent-`, `understanding-`) and the store upserts by
 * (owner, key), so repeated compactions refresh rather than duplicate.
 */

import { Messages, type MessageRow } from '@snaglet/db/tables/messages';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import { getErrorMessage, safeJsonParse } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { memoryService } from '@server/services/MemoryService';
import { resolveUtilityModel, type ResolvedUtilityModel } from './UtilityModelResolver';
import { generateUtilityText } from './generateUtilityText';
// The proposal's owner is the thread's single human (zero or several: dropped).
import { resolveProposalMemberId } from './threadHuman';

/**
 * Hard cap on memories saved per compaction pass. Enforced in code (the
 * parser truncates), not merely asked of the model.
 */
export const MEMORY_EXTRACTION_MAX_CANDIDATES = 3;

/** Per-message preview bound, mirroring the summary formatter's discipline. */
const MESSAGE_PREVIEW_CHARS = 500;

/** Overhead reserved out of the model's input budget for framing text. */
const PROMPT_OVERHEAD_CHARS = 600;

/** Floor for the packed-span budget so a degenerate window still works. */
const MIN_SPAN_BUDGET_CHARS = 1_000;

/** Upper bound on a stored memory key, prefix included. */
const MEMORY_KEY_MAX_CHARS = 80;

/**
 * The kinds of memory worth keeping from a compacted span, most valuable
 * first. `understanding` is the fallback for a candidate whose kind the model
 * omitted or invented: tolerated, never dropped for it.
 */
export const MEMORY_KINDS = ['connection', 'user', 'agent', 'understanding'] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Kind applied when the model omits one or emits something unrecognized. */
export const DEFAULT_MEMORY_KIND: MemoryKind = 'understanding';

export interface ExtractedMemoryCandidate {
  /** Final storage key, already kind-prefixed and kebab-cased. */
  key: string;
  content: string;
  scope: 'agent' | 'member';
  kind: MemoryKind;
}

export interface MemoryExtractionResult {
  /** Agent-scoped memories written (active, verified=false). */
  saved: number;
  /** Member-scoped proposals written (status='proposed', never active). */
  proposed: number;
  /** Writes that refreshed an existing key instead of adding a row. */
  duplicates: number;
  /** Candidates discarded: invalid shape, unresolvable member, failed save. */
  dropped: number;
}

const EMPTY_RESULT: MemoryExtractionResult = Object.freeze({
  saved: 0,
  proposed: 0,
  duplicates: 0,
  dropped: 0,
});

/**
 * Extraction demands strict JSON, unlike the summary prompts. That is a
 * deliberate trade: a small model that cannot produce JSON yields zero
 * candidates — logged, harmless — whereas free text would need a second
 * model call to interpret.
 */
export const MEMORY_EXTRACTION_INSTRUCTIONS =
  'You extract the few most valuable durable memories from a conversation span that is about to be ' +
  'compacted away. Prefer insight and connection over restating events. ' +
  `Return STRICT JSON: an array of at most ${MEMORY_EXTRACTION_MAX_CANDIDATES} objects, ` +
  'each shaped {"key": "...", "content": "...", "scope": "...", "kind": "..."}. ' +
  `Choose the ${MEMORY_EXTRACTION_MAX_CANDIDATES} MOST VALUABLE memories from these kinds, ` +
  'in this order of preference:\n' +
  '1. "connection" — how things in the conversation relate: this decision depends on that component, ' +
  'this person or agent owns that area, cause and effect, what blocked what.\n' +
  '2. "user" — the human user themselves: their preferences, rulings, working style, constraints, ' +
  'and who they mention.\n' +
  '3. "agent" — a particular agent: what it is good or bad at, how it behaved, what worked or did not ' +
  'work with it, handoff patterns.\n' +
  '4. "understanding" — the broad gist, goal, or state of the conversation that would let a fresh agent ' +
  'orient itself. The shape of the thing, not a blow-by-blow of what was said.\n' +
  'A memory that records a lesson must say what worked or what failed AND why, in one self-contained sentence. ' +
  'kind: one of "connection", "user", "agent", "understanding". ' +
  'key: a short kebab-case identifier for the memory, stable if the same memory were extracted again ' +
  '(e.g. "db-mode-external", "clio-good-at-triage", "deploy-needs-manual-migrate"). ' +
  'content: ONE self-contained sentence stating the memory with its specifics, understandable months ' +
  'from now by someone who never saw this conversation. ' +
  'scope: "member" for memories of kind "user" (facts about the human themselves); ' +
  '"agent" for every other kind. ' +
  'Only include memories still worth knowing months from now. Exclude transient status, greetings, ' +
  'speculation, and anything already obvious from the codebase. ' +
  'If the span contains nothing durable, return []. Output ONLY the JSON array, no code fences, no commentary.';

/**
 * Retry prompt, mirroring SIMPLE_THREAD_SUMMARY_INSTRUCTIONS: a much shorter
 * ask for the second attempt after an unusable first response.
 */
export const SIMPLE_MEMORY_EXTRACTION_INSTRUCTIONS =
  'Read the conversation below. Output a JSON array of at most ' +
  `${MEMORY_EXTRACTION_MAX_CANDIDATES} objects like ` +
  '{"key": "short-kebab-case-id", "content": "One sentence stating a lasting memory.", ' +
  '"scope": "agent", "kind": "connection"}. ' +
  `Pick the ${MEMORY_EXTRACTION_MAX_CANDIDATES} most valuable, preferring in this order: ` +
  'kind "connection" (how things in the conversation relate — what depends on what, who owns what, ' +
  'what blocked what), kind "user" (the human\'s preferences, rulings, working style, constraints), ' +
  'kind "agent" (what an agent is good or bad at, what worked or did not work with it), ' +
  'kind "understanding" (the gist and goal of the conversation, enough for a fresh agent to orient). ' +
  'A lesson must say what worked or failed AND why, in one sentence. ' +
  'Use scope "member" only for kind "user"; everything else is scope "agent". ' +
  'Keep only what is still worth knowing months from now. ' +
  'If there are no lasting memories, output []. Output only the JSON array.';

function buildExtractionUserPrompt(formattedSpan: string, messageCount: number): string {
  return `CONVERSATION SPAN (${messageCount} messages, about to be compacted):\n${formattedSpan}`;
}

/**
 * Normalize a model-emitted key to kebab-case. Returns null when nothing
 * usable survives — the candidate is then dropped rather than saved under a
 * garbage key.
 */
export function normalizeMemoryKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MEMORY_KEY_MAX_CHARS);
  return key.length > 0 ? key : null;
}

/**
 * Coerce a model-emitted `kind` to a known one. A missing, non-string or
 * unrecognized kind yields DEFAULT_MEMORY_KIND rather than dropping the
 * candidate: the kind is a recall aid, not a safety boundary (scope is the
 * safety boundary, and it stays strict).
 */
export function normalizeMemoryKind(raw: unknown): MemoryKind {
  if (typeof raw !== 'string') return DEFAULT_MEMORY_KIND;
  const normalized = raw.trim().toLowerCase();
  return (MEMORY_KINDS as readonly string[]).includes(normalized)
    ? (normalized as MemoryKind)
    : DEFAULT_MEMORY_KIND;
}

/**
 * Prefix a normalized key with its kind, idempotently: a key the model already
 * emitted as `agent-clio-slow` is not rewritten to `agent-agent-clio-slow`,
 * so the same fact produces the same key on every pass (the upsert-by-key
 * dedupe depends on that stability).
 */
export function applyKindPrefix(key: string, kind: MemoryKind): string {
  const prefixed = key === kind || key.startsWith(`${kind}-`) ? key : `${kind}-${key}`;
  // Re-bound after prefixing: the column and the normalizer share this cap.
  return prefixed.slice(0, MEMORY_KEY_MAX_CHARS).replace(/-+$/, '');
}

/** Strip a leading/trailing markdown code fence if the model added one anyway. */
function stripCodeFences(text: string): string {
  const fenced = text.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```\s*$/);
  return fenced?.[1] ?? text;
}

/**
 * Extract the candidate array from the raw response: direct JSON, or the
 * outermost bracketed slice when the model wrapped the array in prose.
 * Returns null when no JSON array can be found at all.
 */
function parseCandidateArray(raw: string): unknown[] | null {
  const text = stripCodeFences(raw.trim());

  let parsed = safeJsonParse<unknown>(text, null);
  if (!Array.isArray(parsed)) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    parsed =
      start >= 0 && end > start ? safeJsonParse<unknown>(text.slice(start, end + 1), null) : null;
  }
  return Array.isArray(parsed) ? parsed : null;
}

/**
 * Decide whether a response is unusable and worth the single retry: blank
 * output, or output with no recoverable JSON array (both are what a cold
 * local model produces). A response that parses to an array — even `[]`, or
 * an array whose items all fail validation — is a structural decision by the
 * model and is not retryable.
 */
function classifyUnusableExtractionOutput(raw: string): string | null {
  if (raw.trim().length === 0) return 'empty output';
  if (parseCandidateArray(raw) === null) return 'malformed output (no JSON array)';
  return null;
}

/**
 * Parse the model's response into validated candidates. Malformed output —
 * non-JSON, non-array, junk items — degrades to fewer (or zero) candidates,
 * never an error. Keys are kind-prefixed, deduplicated by (scope, key), and
 * the result is truncated to MEMORY_EXTRACTION_MAX_CANDIDATES: the cap is
 * enforced here regardless of what the model returned.
 */
export function parseExtractionResponse(raw: string): ExtractedMemoryCandidate[] {
  const parsed = parseCandidateArray(raw);
  if (parsed === null) return [];

  const seen = new Set<string>();
  const candidates: ExtractedMemoryCandidate[] = [];
  for (const item of parsed) {
    if (candidates.length >= MEMORY_EXTRACTION_MAX_CANDIDATES) break;
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;

    const rawKey = normalizeMemoryKey(record.key);
    const content = typeof record.content === 'string' ? record.content.trim().slice(0, 2_000) : '';
    const scope = record.scope;
    // Scope is validated strictly: a missing/unknown scope is dropped rather
    // than defaulted to 'agent', so a fact about the human can never slip
    // into auto-save through a sloppy scope field. Kind, by contrast, is
    // tolerant (see normalizeMemoryKind) — it only steers recall.
    if (!rawKey || !content || (scope !== 'agent' && scope !== 'member')) continue;

    const kind = normalizeMemoryKind(record.kind);
    const key = applyKindPrefix(rawKey, kind);

    const dedupeKey = `${scope}:${key}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    candidates.push({ key, content, scope, kind });
  }
  return candidates;
}

/**
 * Reconstruct the message span the current summary version newly covered for
 * (thread, agent): everything after the previous version's lastMessageId
 * boundary, through the current version's. This is the same span the
 * summarizer just read — the messages about to become unreachable.
 */
async function loadCompactedSpan(threadId: string, agentId: string): Promise<MessageRow[]> {
  const history = await ThreadSummaries.getHistoryByThreadAndAgent(threadId, agentId);
  const current = history.find((row) => row.isCurrent) ?? history[0] ?? null;
  if (!current) return [];
  // History is version-DESC, so the first strictly-older version is the
  // previous boundary.
  const previous = history.find((row) => row.version < current.version) ?? null;

  const all = await Messages.listByThreadId(threadId);
  // A missing previous boundary (fresh summary, or the boundary message was
  // deleted) starts the span at the beginning: findIndex's -1 + 1 === 0.
  const startIdx = previous?.lastMessageId
    ? all.findIndex((m) => m.id === previous.lastMessageId) + 1
    : 0;
  const endIdx = current.lastMessageId ? all.findIndex((m) => m.id === current.lastMessageId) : -1;
  // Missing current boundary: best-effort tail rather than nothing.
  return endIdx >= 0 ? all.slice(startIdx, endIdx + 1) : all.slice(startIdx);
}

/** The messages of the folded replay units: a unit is a message itself or all of a run's. */
async function loadFoldedUnitMessages(
  threadId: string,
  unitIds: readonly string[]
): Promise<MessageRow[]> {
  const ids = new Set(unitIds);
  const all = await Messages.listByThreadId(threadId);
  return all.filter((message) => ids.has(message.id) || (message.runId && ids.has(message.runId)));
}

function formatSpanLine(message: MessageRow, agentNameMap?: Map<string, string>): string {
  const speaker =
    message.role === 'assistant' && message.agentId
      ? (agentNameMap?.get(message.agentId) ?? 'Agent')
      : message.role === 'user'
        ? 'User'
        : message.role;
  const preview =
    message.content.length > MESSAGE_PREVIEW_CHARS
      ? `${message.content.slice(0, MESSAGE_PREVIEW_CHARS)}…`
      : message.content;
  return `[${speaker}]: ${preview}`;
}

/**
 * Pack the span oldest-first against the resolved model's input budget —
 * the same cap discipline the summary pass applies. Extraction
 * is best-effort, so an over-budget suffix is simply not mined this pass.
 */
function packSpan(
  messages: MessageRow[],
  agentNameMap: Map<string, string> | undefined,
  model: ResolvedUtilityModel
): { formatted: string; included: number } {
  const budget = Math.max(
    MIN_SPAN_BUDGET_CHARS,
    model.maxInputChars - MEMORY_EXTRACTION_INSTRUCTIONS.length - PROMPT_OVERHEAD_CHARS
  );
  const lines: string[] = [];
  let total = 0;
  for (const message of messages) {
    const line = formatSpanLine(message, agentNameMap);
    const cost = line.length + 2;
    if (lines.length > 0 && total + cost > budget) break;
    lines.push(line);
    total += cost;
  }
  return { formatted: lines.join('\n\n'), included: lines.length };
}

export interface MemoryExtractionArgs {
  threadId: string;
  agentId: string;
  agentNameMap?: Map<string, string>;
  /**
   * Ids of the replay units a history compaction just folded (message ids and run ids). When
   * given, exactly the messages in those units are mined; otherwise the span the latest digest
   * version covered is.
   */
  foldedUnitIds?: readonly string[];
}

/**
 * Extract durable memories from the span the latest (thread, agent) summary
 * covered. Never throws and never interferes with the caller — compaction
 * must complete identically whether this saves five memories or dies on the
 * first line.
 */
export async function extractMemoriesFromCompaction(
  args: MemoryExtractionArgs
): Promise<MemoryExtractionResult> {
  const label = `thread ${args.threadId} / agent ${args.agentId}`;
  try {
    const span = (
      args.foldedUnitIds
        ? await loadFoldedUnitMessages(args.threadId, args.foldedUnitIds)
        : await loadCompactedSpan(args.threadId, args.agentId)
    ).filter((message) => message.messageType !== 'thread_event');
    if (span.length === 0) {
      logger.debug(`[memory-extraction] ${label}: no compacted span to mine`);
      return EMPTY_RESULT;
    }

    // Same resolution chain (and privacy rules) as the summary that just ran.
    const resolution = await resolveUtilityModel({
      purpose: 'thread-summary',
      threadId: args.threadId,
      agentId: args.agentId,
    });
    if (!resolution.ok) {
      logger.debug(`[memory-extraction] ${label}: no utility model (${resolution.reason})`);
      return EMPTY_RESULT;
    }

    const packed = packSpan(span, args.agentNameMap, resolution.model);
    const userMessage = buildExtractionUserPrompt(packed.formatted, packed.included);
    let raw = await generateUtilityText(resolution.model, {
      system: MEMORY_EXTRACTION_INSTRUCTIONS,
      userMessage,
      maxOutputTokens: 1024,
    });

    // One retry with a simplified prompt, only when the response is unusable
    // (blank or no JSON array) — never when the model deliberately answered
    // `[]`. Mirrors the summary path's discipline; a throw here is contained
    // by the outer catch like any other model failure.
    const firstProblem = classifyUnusableExtractionOutput(raw);
    if (firstProblem !== null) {
      // warn, not info — parity with the summary path's retry discard
      // (SummaryService.ts).
      logger.warn(
        `[memory-extraction] ${label}: discarded output from ` +
          `${resolution.model.providerId}/${resolution.model.modelId} (${firstProblem}) — ` +
          'retrying with simplified prompt'
      );
      raw = await generateUtilityText(resolution.model, {
        system: SIMPLE_MEMORY_EXTRACTION_INSTRUCTIONS,
        userMessage,
        maxOutputTokens: 1024,
      });
      const retryProblem = classifyUnusableExtractionOutput(raw);
      if (retryProblem !== null) {
        logger.warn(
          `[memory-extraction] ${label}: discarded retry output from ` +
            `${resolution.model.providerId}/${resolution.model.modelId} (${retryProblem}) — ` +
            'no memories this pass'
        );
        return EMPTY_RESULT;
      }
    }

    const candidates = parseExtractionResponse(raw);
    if (candidates.length === 0) {
      logger.debug(`[memory-extraction] ${label}: no durable facts extracted`);
      return EMPTY_RESULT;
    }

    // Resolved once, only if some candidate needs it.
    let proposalMemberId: string | null | undefined;

    let saved = 0;
    let proposed = 0;
    let duplicates = 0;
    let dropped = 0;
    const kindTally: string[] = [];
    for (const candidate of candidates) {
      try {
        if (candidate.scope === 'member') {
          if (proposalMemberId === undefined) {
            proposalMemberId = await resolveProposalMemberId(args.threadId);
          }
          if (!proposalMemberId) {
            dropped += 1;
            continue;
          }
          // Member facts are stored INERT: status 'proposed', never active.
          const outcome = await memoryService.store({
            memberId: proposalMemberId,
            threadId: args.threadId,
            key: candidate.key,
            content: candidate.content,
            verified: false,
            status: 'proposed',
          });
          proposed += 1;
          if (outcome?.isDuplicate) duplicates += 1;
        } else {
          const outcome = await memoryService.store({
            agentId: args.agentId,
            threadId: args.threadId,
            key: candidate.key,
            content: candidate.content,
            verified: false,
            status: 'active',
          });
          saved += 1;
          if (outcome?.isDuplicate) duplicates += 1;
        }
        kindTally.push(candidate.kind);
      } catch (error) {
        dropped += 1;
        logger.debug(
          `[memory-extraction] ${label}: failed to save '${candidate.key}': ${getErrorMessage(error)}`
        );
      }
    }

    // ONE line per compaction with every count, so a pass that wrote nothing
    // is as visible as one that wrote three (a silent extractor was
    // indistinguishable from a disabled one before).
    logger.info(
      `[memory-extraction] ${label}: active ${saved}, proposed ${proposed}, ` +
        `refreshed-dup ${duplicates}, dropped-invalid ${dropped}` +
        (kindTally.length > 0 ? ` [${kindTally.join(', ')}]` : '')
    );
    return { saved, proposed, duplicates, dropped };
  } catch (error) {
    logger.warn(`[memory-extraction] ${label}: extraction failed: ${getErrorMessage(error)}`);
    return EMPTY_RESULT;
  }
}
