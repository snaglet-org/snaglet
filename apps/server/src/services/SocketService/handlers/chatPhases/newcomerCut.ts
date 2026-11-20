/**
 * The newcomer cut: an agent that has never spoken in a thread gets the newest replay units that
 * fit a share of its model window, and nothing older. It never summarizes the history it missed
 * and never borrows another agent's fold; the cut is persisted as its own compaction so later
 * turns replay from it and fold normally from there.
 */

import type { ProviderMessage } from '@server/services/ProviderChatService';
import { estimateReplayTokens, type ReplayUnitKey, type ReplayUnitSpan } from './replayAssembly';

/** The share of the model's declared context window a newcomer's replay may use. */
const NEWCOMER_WINDOW_SHARE = 0.3;

export function newcomerTailCap(contextWindowTokens: number): number {
  return Math.floor(contextWindowTokens * NEWCOMER_WINDOW_SHARE);
}

export interface NewcomerCutPlan {
  /** The last unit left out; everything after it replays. */
  through: ReplayUnitKey;
  omittedUnits: number;
}

/**
 * The cut that keeps the newest units within `capTokens`, or null when the whole history fits.
 * The newest unit always stays, so a single oversized turn is never cut to nothing.
 */
export function planNewcomerCut(args: {
  messages: readonly ProviderMessage[];
  units: readonly ReplayUnitSpan[];
  capTokens: number;
}): NewcomerCutPlan | null {
  const { messages, units, capTokens } = args;
  if (units.length === 0) return null;
  let firstKept = units.length - 1;
  let kept = unitTokens(messages, units, firstKept);
  while (firstKept > 0) {
    const next = unitTokens(messages, units, firstKept - 1);
    if (kept + next > capTokens) break;
    kept += next;
    firstKept -= 1;
  }
  if (firstKept === 0) return null;
  return { through: units[firstKept - 1]!.key, omittedUnits: firstKept };
}

function unitTokens(
  messages: readonly ProviderMessage[],
  units: readonly ReplayUnitSpan[],
  index: number
): number {
  const start = index === 0 ? 0 : units[index - 1]!.end;
  return estimateReplayTokens(messages.slice(start, units[index]!.end) as ProviderMessage[]);
}
