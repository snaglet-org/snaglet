/**
 * Group-chat governance constants + server-level budget ceilings.
 *
 * Different axis from the existing per-agent dispatch limits in
 * `dispatchToThread.ts` (`SOFT_DISPATCH_THRESHOLD`, `HARD_DISPATCH_CEILING`):
 * those cap how many times any single agent can be dispatched within a
 * conversation. The values here cap the conversation as a whole (waves,
 * total output tokens) and the inbound request shape (mention fan-out).
 *
 * Ceiling design: every conversation
 * limit is three-tier — `min(threadOverride ?? settingsDefault, serverCeiling)`.
 * The ceilings below are the server tier: env-overridable for operators, with
 * hardcoded generous defaults. Config drift cannot weaken the safety net
 * because all tiers combine by `min`; a nonsense env value falls back to the
 * hardcoded default.
 *
 * There is no conversation-wide tool-iteration ceiling: per-turn tool churn is
 * bounded by the per-agent per-turn cap (`settings/categories/tool.ts`).
 */

import { DEFAULT_CONVERSATION_OUTPUT_TOKENS } from '@snaglet/shared/constants';
import { logger } from '@server/config/logger';

/**
 * Server ceiling on dispatch waves per conversation. The operating limit is
 * the thread/settings `maxWaves` (default 6); this ceiling is the absolute
 * backstop no override can exceed. A thread `maxWaves: null` means "up to
 * this ceiling" — there is no unlimited.
 */
export const DEFAULT_MAX_WAVES_CEILING = 24;

/**
 * Server ceiling on total output tokens per user message (all agents). The
 * same value is the settings default, so an untouched install runs at the
 * ceiling; a single reply is never limited by either.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS_CEILING = DEFAULT_CONVERSATION_OUTPUT_TOKENS;

function resolveCeilingEnv(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    logger.warn(
      `[safety] ${envVar}=${JSON.stringify(raw)} is not a positive integer — using default ${fallback}`
    );
    return fallback;
  }
  return parsed;
}

/** Effective wave ceiling: `SNAGLET_MAX_WAVES_CEILING` env or the default. */
export function resolveMaxWavesCeiling(): number {
  return resolveCeilingEnv('SNAGLET_MAX_WAVES_CEILING', DEFAULT_MAX_WAVES_CEILING);
}

/** Effective output-token ceiling: `SNAGLET_MAX_OUTPUT_TOKENS_CEILING` env or default. */
export function resolveMaxOutputTokensCeiling(): number {
  return resolveCeilingEnv('SNAGLET_MAX_OUTPUT_TOKENS_CEILING', DEFAULT_MAX_OUTPUT_TOKENS_CEILING);
}

/**
 * Clamp a requested per-conversation limit to a server ceiling, logging when
 * the clamp actually changes the value (so a configured-but-overridden
 * setting is never silently ignored).
 *
 * `maxWaves` is deliberately not a valid `field` here — waves are not
 * clamped through this function, so no call site should ever pass it.
 */
export function clampToCeiling(
  field: 'maxTotalOutputTokens',
  requested: number,
  ceiling: number
): number {
  if (requested > ceiling) {
    logger.info(
      `[safety] budget override clamped: ${field} requested=${requested} ceiling=${ceiling}`
    );
    return ceiling;
  }
  return requested;
}

/**
 * Maximum number of agents that can be @-mentioned in a single user
 * message. Rejecting at the API boundary prevents the fan-out from
 * exceeding what's healthy for a coherent conversation.
 *
 * 4 is empirical: 3-agent group chats already feel busy in practice
 * (empirically, 3 agents kept the conversation legible);
 * 4 leaves headroom; 5+ tends to degenerate into agents talking past
 * each other.
 */
export const MAX_AGENTS_PER_MESSAGE = 4;

/**
 * Validate an inbound chat message against `MAX_AGENTS_PER_MESSAGE`.
 * Returns null on success, or a human-readable error string on rejection.
 * Designed to be called once per message at the API boundary AND once
 * defensively in the orchestrator (the orchestrator's check is cheap;
 * a malformed inbound shouldn't crash a conversation in flight).
 *
 * `mentionedAgentIds` is the deduplicated set of agent IDs extracted
 * from the user message body (whatever the mention parser returned).
 * Pass an array (the mention parser's natural shape) — if you have a Set,
 * spread it: `validateMentionFanOut([...mySet])`.
 */
export function validateMentionFanOut(mentionedAgentIds: ReadonlyArray<string>): string | null {
  const count = mentionedAgentIds.length;
  if (count > MAX_AGENTS_PER_MESSAGE) {
    return `Too many agents mentioned in a single message: ${count} (max ${MAX_AGENTS_PER_MESSAGE}).`;
  }
  return null;
}
