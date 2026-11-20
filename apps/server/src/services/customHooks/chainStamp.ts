/**
 * Chain context carried on a persisted message.
 *
 * A hook's `thread op:send` to a busy thread is queued and delivered later,
 * from the run that held the thread; without a stamp the delivery wave would
 * run in that finishing run's context and lose its true chain depth. Depth
 * and chain never refuse a run, but they are recorded on every run for
 * visibility. The sender stamps `metadata.chain = { depth, hooks }` on
 * the message row; redispatch reads the stamps of every queued message it
 * covers and binds the merged context.
 *
 * Trust boundary: only the server writes `metadata.chain` (postAgentMessageToThread).
 * Inbound socket/REST message paths build metadata from an allow-list that
 * excludes `chain`; `readChainStamp` also rejects anything that is not the
 * exact server shape. An unstamped message is depth 0 (a person's message).
 *
 * A covered message whose row can't be loaded has an unknown stamp, not an
 * absent one: it may be a hook's message at some depth. It counts as
 * {@link unknownChainStamp} (depth 1) so the wave records a hook-caused depth
 * rather than reading as a person's message (depth 0). This only affects what
 * the run records.
 */
import {
  MAX_HOOK_CHAIN_LENGTH,
  currentChainDepth,
  currentHookChain,
  currentUnattendedCap,
  normalizeChainDepth,
  normalizeHookChain,
  raiseAmbientChainContext,
  raiseAmbientUnattendedCap,
} from '../../realtime/runContext';
import { getCurrentActor } from '../../realtime/actorContext';

export interface ChainStamp {
  depth: number;
  hooks: readonly string[];
  /**
   * The sender may not auto-approve what this message wakes: an agent started
   * or caused the hook run that sent it, or an agent sent it (see
   * unattendedWake.ts). Kept on the row so a wake delivered after a busy
   * thread's run ends is capped the same way.
   */
  capped?: true;
}

/** The `metadata` to persist for a message sent from the current context, or null at depth 0. */
export function chainStampMetadata(): { chain: ChainStamp } | null {
  const depth = currentChainDepth();
  if (depth <= 0) return null;
  const capped = currentUnattendedCap() || getCurrentActor()?.actorKind === 'agent';
  return {
    chain: { depth, hooks: [...currentHookChain()], ...(capped ? { capped: true as const } : {}) },
  };
}

/** The stamp on a message's metadata, or null when absent or malformed. */
export function readChainStamp(metadata: unknown): ChainStamp | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const chain = (metadata as Record<string, unknown>).chain;
  if (!chain || typeof chain !== 'object' || Array.isArray(chain)) return null;
  const { depth, hooks, capped } = chain as Record<string, unknown>;
  if (typeof depth !== 'number' || !Number.isFinite(depth)) return null;
  if (!Array.isArray(hooks)) return null;
  const normalized = normalizeChainDepth(depth);
  if (normalized <= 0) return null;
  return {
    depth: normalized,
    hooks: normalizeHookChain(hooks),
    ...(capped === true ? { capped: true as const } : {}),
  };
}

/**
 * The stamp for a queued message whose row failed to load. Its real
 * depth is unknown. Depth never refuses a run, so this only needs to keep
 * the wave from reading as a person's message (depth 0): it records depth 1, a
 * hook-caused run of unknown origin. The wave still delivers normally.
 */
export function unknownChainStamp(): ChainStamp {
  return { depth: 1, hooks: [], capped: true };
}

/**
 * One context for a wave covering several queued messages: the deepest depth,
 * and the deepest message's chain followed by any other hook names not already
 * in it (capped like any chain). Never resets below the deepest stamp.
 */
export function mergeChainStamps(stamps: readonly (ChainStamp | null)[]): ChainStamp | null {
  const present = stamps.filter((s): s is ChainStamp => s !== null);
  if (present.length === 0) return null;
  const deepest = present.reduce((a, b) => (b.depth > a.depth ? b : a));
  const hooks = [...deepest.hooks];
  for (const stamp of present) {
    for (const name of stamp.hooks) if (!hooks.includes(name)) hooks.push(name);
  }
  const capped = present.some((stamp) => stamp.capped === true);
  return {
    depth: deepest.depth,
    hooks: hooks.slice(-MAX_HOOK_CHAIN_LENGTH),
    ...(capped ? { capped: true as const } : {}),
  };
}

/**
 * A running agent was just handed messages mid-run: it acts on them
 * inside the same run, so its ambient context becomes the merge of its current
 * one and their stamps. The depth never decreases, and an unstamped message (a
 * person's) changes nothing. Returns true when the context was raised.
 */
export function raiseAmbientChain(stamps: readonly (ChainStamp | null)[]): boolean {
  const incoming = mergeChainStamps(stamps);
  if (!incoming) return false;
  // A capped message handed to a running agent caps the rest of its run.
  if (incoming.capped) raiseAmbientUnattendedCap();
  const depth = currentChainDepth();
  const hooks = currentHookChain();
  // Current first: at an equal depth its chain stays the base of the merge.
  const merged = mergeChainStamps([{ depth, hooks }, incoming])!;
  if (
    merged.depth === depth &&
    merged.hooks.length === hooks.length &&
    merged.hooks.every((name, i) => name === hooks[i])
  ) {
    return false;
  }
  return raiseAmbientChainContext(merged.depth, merged.hooks);
}
