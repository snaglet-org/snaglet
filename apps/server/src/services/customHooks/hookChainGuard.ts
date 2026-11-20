/**
 * hookChainGuard — the one gate every hook run passes before it may take an
 * execution slot (HookRunner.runInternal / runForTestReserved). It covers
 * events, `snaglet.hooks.run` / `hook(op:run)`, and schedules.
 *
 * Snaglet does not refuse loops. A hook that fires on every edit runs on every
 * edit; chain depth and "this hook already ran in the chain" are recorded for
 * visibility (depth/chain stamped on every run row) but never refuse a run.
 * The author decides when to stop — a loop you want ends on its own, through
 * the hook's own conditions. The two guards are not about edit-driven loops:
 *
 *   - Nested self-run: a hook that calls itself synchronously via
 *     `snaglet.hooks.run` / `hook(op:run)` while it is still running. That is unbounded
 *     recursion inside one run (the caller waits on the callee, which waits on
 *     the next), not an edit loop, so it is refused outright.
 *   - A burst: more than `workers.hooks_max_runs_per_minute` (default 600)
 *     runs of one hook in any rolling minute. Every automatic run counts;
 *     schedules and a person's own depth-0 runs don't. Held in memory, so the
 *     window starts over on restart. It is the backstop against a tight
 *     runaway — a last-resort rate cap, not a loop detector.
 *
 * A refused run spawns nothing and sends no `hook:finished`. The runner
 * records it as a failed run whose stderr names the limit and the chain.
 * Rows are capped at one per hook and limit per minute: later refusals in
 * that minute are counted, logged when the minute closes, and the count is
 * carried into that hook's next refusal row.
 */

import type { HookRunSource } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { MAX_HOOK_CHAIN_NAME_LENGTH, extendHookChain } from '@server/realtime/runContext';
import { settingsService } from '@server/services/settings/settingsService';
import { workerSettings } from '@server/services/settings/categories/workers';

const LOG_PREFIX = '\x1b[34m[hooks]\x1b[0m';
/** The burst window and the refusal-row window. */
const WINDOW_MS = 60_000;

export interface HookChainLimits {
  maxRunsPerMinute: number;
}

export const DEFAULT_HOOK_CHAIN_LIMITS: HookChainLimits = {
  maxRunsPerMinute: workerSettings.hooksMaxRunsPerMinute.default,
};

/** The limits in Settings (cached 30 s); the defaults when they can't be read. */
export async function readHookChainLimits(): Promise<HookChainLimits> {
  try {
    const maxRunsPerMinute = await settingsService.read(workerSettings.hooksMaxRunsPerMinute);
    return { maxRunsPerMinute };
  } catch (err) {
    logger.warn(
      `${LOG_PREFIX} hook chain limits unreadable, using defaults: ${getErrorMessage(err)}`
    );
    return DEFAULT_HOOK_CHAIN_LIMITS;
  }
}

/**
 * Which limit refused a run. `chain` means a hook's nested self-run (the one
 * chain shape refused); `slots` is the runner's: a nested run found no free
 * slot.
 */
export type HookChainLimit = 'chain' | 'burst' | 'slots';

const LIMIT_NAMES: Record<HookChainLimit, string> = {
  chain: 'nested self-run limit',
  burst: 'runs-per-minute limit',
  slots: 'nested-run slot limit',
};

export interface HookChainRequest {
  hookName: string;
  source: HookRunSource;
  /** Depth of whatever caused the run; the run itself is one deeper. */
  causeDepth: number;
  /** Chain of whatever caused the run; the run itself adds its own name. */
  causeChain: readonly string[];
  /**
   * @deprecated No-op. Snaglet does not refuse a hook that already ran in its
   * chain, so there is nothing to opt out of. Still accepted so existing hooks
   * keep loading.
   */
  repeatInChain: boolean;
  /** Run on demand by running hook code (snaglet.hooks.run / hook op:run), which waits for it. */
  nested: boolean;
}

interface HookChainAdmission {
  allowed: true;
  /** Depth the run executes at. */
  depth: number;
  /** Chain the run executes in (its cause's chain plus its own name). */
  chain: readonly string[];
  /** Take the run back out of the burst count (it was refused after admission). */
  uncount(): void;
}

export interface HookChainRefusal {
  allowed: false;
  limit: HookChainLimit;
  depth: number;
  chain: readonly string[];
  /** The reason, as recorded in the run's stderr and returned to a caller. */
  stderr: string;
  /** False when this hook already has a row for this limit in the current minute. */
  record: boolean;
}

export type HookChainVerdict = HookChainAdmission | HookChainRefusal;

interface RefusalWindow {
  openedAt: number;
  /** Refusals in this window beyond the one recorded. */
  suppressed: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** "A → B → A" */
function formatHookChain(chain: readonly string[]): string {
  return chain.join(' → ');
}

/** Schedules and a person's own runs (depth 0 → the run is depth 1) never count. */
function countsTowardBurst(request: HookChainRequest): boolean {
  if (request.source === 'schedule') return false;
  if (request.source === 'manual') return request.causeDepth > 0;
  return true;
}

export class HookChainGuard {
  /** Start times of counted runs per hook, oldest first, within the window. */
  private readonly runs = new Map<string, number[]>();
  private readonly refusals = new Map<string, RefusalWindow>();
  /** Suppressed refusals from closed windows, for the next row of that key. */
  private readonly carried = new Map<string, number>();

  /** Admit or refuse one run. Check and count happen with no await between them. */
  check(request: HookChainRequest, limits: HookChainLimits): HookChainVerdict {
    const { hookName } = request;
    // Depth and chain are computed and returned so the run records them;
    // neither refuses a run.
    const depth = request.causeDepth + 1;
    const chain = extendHookChain(request.causeChain, hookName);
    const caller = request.causeChain[request.causeChain.length - 1];
    if (request.nested && caller === hookName.slice(0, MAX_HOOK_CHAIN_NAME_LENGTH)) {
      // Not an edit-driven loop: a hook calling itself synchronously via
      // snaglet.hooks.run / hook(op:run) while still running is unbounded recursion
      // inside one run, so it is refused.
      return this.refuse(
        'chain',
        hookName,
        depth,
        chain,
        `"${hookName}" can't run itself (snaglet.hooks.run or hook op:run) while it is running`
      );
    }
    if (!countsTowardBurst(request)) {
      return { allowed: true, depth, chain, uncount: () => undefined };
    }
    const now = Date.now();
    const recent = (this.runs.get(hookName) ?? []).filter((at) => now - at < WINDOW_MS);
    if (recent.length >= limits.maxRunsPerMinute) {
      this.runs.set(hookName, recent);
      return this.refuse(
        'burst',
        hookName,
        depth,
        chain,
        `"${hookName}" already ran ${recent.length} times in the last minute ` +
          `(limit: workers.hooks_max_runs_per_minute = ${limits.maxRunsPerMinute})`
      );
    }
    recent.push(now);
    this.runs.set(hookName, recent);
    return {
      allowed: true,
      depth,
      chain,
      uncount: () => {
        const list = this.runs.get(hookName);
        const at = list?.indexOf(now) ?? -1;
        if (list && at >= 0) list.splice(at, 1);
      },
    };
  }

  /**
   * A refusal, worded with the limit and the chain. The first one per hook and
   * limit in a minute is to be recorded; the rest are counted.
   */
  refuse(
    limit: HookChainLimit,
    hookName: string,
    depth: number,
    chain: readonly string[],
    detail: string
  ): HookChainRefusal {
    const key = `${limit}\u0000${hookName}`;
    const now = Date.now();
    const open = this.refusals.get(key);
    if (open && now - open.openedAt >= WINDOW_MS) this.closeWindow(key, limit, hookName);
    let stderr = `Stopped by the ${LIMIT_NAMES[limit]}: ${detail}. Chain: ${formatHookChain(chain)}.`;
    const current = this.refusals.get(key);
    if (current) {
      current.suppressed += 1;
      if (!current.timer) {
        current.timer = setTimeout(
          () => this.closeWindow(key, limit, hookName),
          Math.max(0, current.openedAt + WINDOW_MS - now)
        );
        current.timer.unref?.();
      }
      return { allowed: false, limit, depth, chain, stderr, record: false };
    }
    const carried = this.carried.get(key) ?? 0;
    if (carried > 0) {
      this.carried.delete(key);
      stderr +=
        ` ${carried} earlier refusal${carried === 1 ? '' : 's'} of this kind ` +
        `${carried === 1 ? 'was' : 'were'} not recorded (one row per hook and limit per minute).`;
    }
    this.refusals.set(key, { openedAt: now, suppressed: 0 });
    return { allowed: false, limit, depth, chain, stderr, record: true };
  }

  /** Close every open refusal window now, logging what each counted (shutdown, tests). */
  flush(): void {
    for (const key of [...this.refusals.keys()]) {
      const [limit, hookName] = key.split('\u0000') as [HookChainLimit, string];
      this.closeWindow(key, limit, hookName);
    }
  }

  private closeWindow(key: string, limit: HookChainLimit, hookName: string): void {
    const window = this.refusals.get(key);
    if (!window) return;
    if (window.timer) clearTimeout(window.timer);
    this.refusals.delete(key);
    if (window.suppressed === 0) return;
    this.carried.set(key, (this.carried.get(key) ?? 0) + window.suppressed);
    logger.warn(
      `${LOG_PREFIX} "${hookName}": ${window.suppressed} more run${window.suppressed === 1 ? ' was' : 's were'} ` +
        `stopped by the ${LIMIT_NAMES[limit]} in the last minute without a run row`
    );
  }
}
