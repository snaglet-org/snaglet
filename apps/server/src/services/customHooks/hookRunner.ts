/**
 * hookRunner — spawn a built hook as a child process, isolated and bounded.
 *
 * Mirrors the workspace-tool spawn contract (ToolExecutor.executeWorkspaceTool):
 * `node <built>` with a JSON payload on stdin and `SNAGLET_SERVER_URL` +
 * `SNAGLET_TOOL_CONTEXT_JSON` in a minimal allow-listed env, so a hook can call back
 * into the server via the vendored `@snaglet/sdk` exactly like a tool. Four extra
 * guarantees make hooks safe as fire-and-forget observers:
 *
 *   - Per-hook timeout (default 30s): a hanging hook is SIGKILL'd and logged;
 *     it never wedges the emitter or a request.
 *   - Concurrency cap: a burst of events can't fork unbounded child processes,
 *     and a nested run that finds no free slot is refused instead of waiting.
 *   - Run limits (hookChainGuard.ts): a hook calling itself while it is still
 *     running, or one over its per-minute budget, is refused before it takes a
 *     slot and recorded as a failed run. Chain depth and the chain of hook
 *     names are recorded on every run but never refuse one.
 *   - Run as (hookRunAs.ts): a hook set to run as an agent acts as that agent
 *     (credential, child context, run record); an agent archived or deleted
 *     since it was picked refuses the run, recorded as a failed run.
 *
 * Every run is crash-isolated: `run()` and `describe()` never reject. A hook
 * that throws, hangs, or exits non-zero is logged with a clear prefix and the
 * server + message flow are unaffected.
 */

import { spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { logger } from '@server/config/logger';
import type { HookRunSource } from '@snaglet/shared/types';
import { getErrorMessage, elapsedMs } from '@snaglet/shared/utils';
import { activeWorkRegistry } from '@server/services/ActiveWorkRegistry';
import { buildToolEnv } from '@server/services/ToolService/lib/buildSafeEnv';
import { mintChildDispatchToken } from '@server/middleware/panelAuth';
import { GHOST_AGENT_ID } from '@snaglet/shared/constants/systemAgents';
import { hookExecutionCoordinator } from './HookExecutionCoordinator';
import { killProcessTree, nodeExecutable } from '@server/utils/processes';
import {
  currentChainDepth,
  currentHookChain,
  currentUnattendedCap,
  normalizeChainDepth,
  normalizeHookChain,
  runAtChainDepth,
} from '@server/realtime/runContext';
import { getCurrentActor } from '@server/realtime/actorContext';
import { hooks } from '@server/services/HookService';
import { checkHookRunAsAgent } from './hookRunAs';
import {
  DEFAULT_HOOK_CHAIN_LIMITS,
  HookChainGuard,
  type HookChainLimits,
  type HookChainRefusal,
} from './hookChainGuard';

/** Clear, greppable prefix for every hook log line. */
export const HOOK_LOG_PREFIX = '\x1b[34m[hooks]\x1b[0m';

/** Default per-hook run timeout. */
const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
/** Default describe (metadata discovery) timeout — bounded so a bad folder can't hang boot. */
const DEFAULT_HOOK_DESCRIBE_TIMEOUT_MS = 10_000;
/** Default max simultaneous hook child processes. */
const DEFAULT_HOOK_CONCURRENCY = 4;

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface HookRunResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Spawn `node <builtPath> [args]`, write `stdin`, collect output, and resolve a
 * structured result. Kills the child (SIGKILL) on timeout. Rejects only on a
 * spawn-level error (e.g. `node` missing); a non-zero exit resolves normally.
 */
function spawnHookProcess(opts: {
  builtPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  timeoutMs: number;
}): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(nodeExecutable(), [opts.builtPath, ...opts.args], {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: opts.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, opts.timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });

    child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

export interface HookDescribeResult {
  /** Event name(s) the hook subscribes to (raw, un-normalized). */
  on: unknown;
  /** Optional pre-filter (partial payload match), or null. */
  filter: Record<string, unknown> | null;
  /** Durable schedule declarations from defineHook({ schedule: [...] }). */
  schedule: unknown[];
  /** @deprecated No-op (chain repeats are never refused); carried for compatibility. */
  repeatInChain: boolean;
}

/**
 * Discover a hook's metadata by running it in `--describe` mode in a child
 * process. Returns null (never throws) if the process fails, times out, or
 * emits unparseable output.
 */
export async function describeHook(
  builtPath: string,
  cwd: string,
  timeoutMs: number = DEFAULT_HOOK_DESCRIBE_TIMEOUT_MS
): Promise<HookDescribeResult | null> {
  try {
    const result = await spawnHookProcess({
      builtPath,
      args: ['--describe'],
      cwd,
      env: buildToolEnv({}),
      stdin: '',
      timeoutMs,
    });
    if (result.timedOut) {
      logger.warn(`${HOOK_LOG_PREFIX} describe timed out after ${timeoutMs}ms: ${builtPath}`);
      return null;
    }
    if (result.code !== 0) {
      const details = result.stderr.trim() || result.stdout.trim() || 'no output';
      logger.warn(`${HOOK_LOG_PREFIX} describe exited ${result.code}: ${details.slice(0, 500)}`);
      return null;
    }
    const parsed = JSON.parse(result.stdout.trim() || '{}') as Partial<HookDescribeResult>;
    return {
      on: parsed.on,
      filter:
        parsed.filter && typeof parsed.filter === 'object'
          ? (parsed.filter as Record<string, unknown>)
          : null,
      schedule: Array.isArray(parsed.schedule) ? parsed.schedule : [],
      // A bundle built before the option existed describes without it: false.
      repeatInChain: parsed.repeatInChain === true,
    };
  } catch (err) {
    logger.warn(`${HOOK_LOG_PREFIX} describe failed for ${builtPath}: ${getErrorMessage(err)}`);
    return null;
  }
}

/**
 * A minimal async semaphore — caps concurrent hook child processes. Releasing
 * hands the slot DIRECTLY to the next waiter (rather than bumping a counter a
 * racing `acquire` could steal), so it never over-subscribes under a burst.
 */
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    this.available = Math.max(1, max);
  }

  acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve)).then(() =>
      this.makeRelease()
    );
  }

  /** A free slot now, or null; never waits. A queued waiter is never overtaken. */
  tryAcquire(): (() => void) | null {
    if (this.available <= 0) return null;
    this.available -= 1;
    return this.makeRelease();
  }

  /** A single-use release: pass the held slot to the next waiter, or return it. */
  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next)
        next(); // hand the slot straight to the next waiter (count unchanged)
      else this.available += 1; // no waiter → return the slot to the pool
    };
  }
}

export interface HookRunnerOptions {
  /** URL the child's SDK calls back into (`SNAGLET_SERVER_URL`). */
  serverUrl: string;
  /** Per-hook run timeout. */
  timeoutMs?: number;
  /**
   * Max simultaneous hook child processes. Nested runs (snaglet.hooks.run /
   * hook(op:run) from running hook code) have as many again of their own.
   */
  concurrency?: number;
  /** Optional durable execution recorder. Omitted by isolated runner tests. */
  recorder?: HookRunRecorder;
  /** Current chain limits. Defaults to the settings' defaults (isolated runner tests). */
  limits?: () => Promise<HookChainLimits>;
  /**
   * Checked before a run that has a `runAsAgentId`: null lets it act as that
   * agent, a clause refuses it. Defaults to `checkHookRunAsAgent` (the agent
   * still exists, is not archived and is not a helper).
   */
  checkRunAs?: (agentId: string) => Promise<string | null>;
}

interface HookRunStartRecord {
  id: string;
  hookName: string;
  source: HookRunSource;
  eventName: string;
  agentId?: string;
  threadId?: string;
  /** The depth the run executes at (refusals included). */
  chainDepth: number;
}

export interface HookRunRecorder {
  start(input: HookRunStartRecord): Promise<void>;
  finish(id: string, result: HookRunResult): Promise<void>;
}

/** Context injected into a hook child (`SNAGLET_TOOL_CONTEXT_JSON`), read by the SDK. */
export interface HookRunContext {
  /** Invoking agent — forwarded so `snaglet.tools.execute` runs under that agent's policy. */
  agentId?: string;
  threadId?: string;
  triggerMessageId?: string;
  /**
   * Chain depth of whatever CAUSED this run (the event's depth). The
   * run itself is one hop deeper. Defaults to the ambient run context. Never
   * forwarded inside SNAGLET_TOOL_CONTEXT_JSON; the child gets its own depth via the
   * signed dispatch token and SNAGLET_CHAIN_DEPTH.
   */
  chainDepth?: number;
  /**
   * The hook chain of whatever caused this run, like `chainDepth`: the run
   * itself adds its own name. Defaults to the ambient run context; reaches the
   * child only inside the signed dispatch token.
   */
  hookChain?: readonly string[];
  /**
   * The agent the hook is set to run as (`hook_registrations.run_as_agent_id`).
   * It wins over `agentId`: the dispatch credential, the child's `agentId` and
   * the run record all name it. Never forwarded as its own key.
   */
  runAsAgentId?: string;
  /**
   * The sha256 of the bundle a person approved run as for
   * (`hook_registrations.build_hash` while `run_as_agent_id` was kept). A run
   * as `runAsAgentId` spawns only while the bundle on disk still hashes to
   * it, so a bundle swapped under the build folder never runs as the agent.
   */
  runAsBuildHash?: string;
  /**
   * An agent started or caused this run (its `hook` op `run`, its tool call,
   * its message): whatever the run wakes may not auto-approve. Defaults to the
   * ambient context; reaches the child only inside the signed dispatch token.
   */
  unattendedCap?: boolean;
}

/**
 * Whether a run's cause caps what it wakes at the `skip` unattended policy:
 * the context says so (an agent-caused event), the ambient work is capped, or
 * an agent's tool call is running it (`hook` op `run`, a write that fired it).
 * A schedule or a person's action leaves it uncapped.
 */
export function causeUnattendedCap(context: HookRunContext | undefined): boolean {
  return (
    context?.unattendedCap === true ||
    currentUnattendedCap() ||
    getCurrentActor()?.actorKind === 'agent'
  );
}

/**
 * The agent a run acts as: its run-as agent, else the event's agent, else the
 * ghost system actor. An unbound credential could never execute tools
 * (execution.routes.ts invariant), so a run always binds exactly one.
 */
export function actingAgentId(context: HookRunContext): string {
  return context.runAsAgentId || context.agentId || GHOST_AGENT_ID;
}

/** The agent a run record and the active-work registry name (none for a ghost run). */
function recordedAgent(context: HookRunContext): { agentId?: string } {
  const agentId = context.runAsAgentId || context.agentId;
  return agentId ? { agentId } : {};
}

/** The text a run gets when its bundle is not the build run as was set for. */
function changedBuildRefusal(hookName: string, context: HookRunContext): string {
  return (
    `Refused before running: hook "${hookName}" is set to run as ${context.runAsAgentId}, ` +
    "but the hook's built code changed since Run as was set. Set Run as again in the hook editor."
  );
}

/**
 * The bundle a run starts. A run as an agent is checked against the approved
 * build at the moment it starts, and starts a private, read-only copy of the
 * very bytes it checked, so nothing can swap the shared bundle between the
 * check and the start. Throws (a failed run) when the bytes do not match.
 */
async function startableBundle(
  builtPath: string,
  hookName: string,
  context: HookRunContext
): Promise<{ path: string; dispose: () => Promise<void> }> {
  if (!context.runAsAgentId) return { path: builtPath, dispose: async () => {} };
  const bytes = await readFile(builtPath);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (!context.runAsBuildHash || hash !== context.runAsBuildHash) {
    throw new Error(changedBuildRefusal(hookName, context));
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'snaglet-hook-run-'));
  const copy = path.join(dir, path.basename(builtPath));
  await writeFile(copy, bytes, { mode: 0o400 });
  return {
    path: copy,
    dispose: async () => {
      await rm(dir, { recursive: true, force: true }).catch((err: unknown) =>
        logger.warn(`${HOOK_LOG_PREFIX} could not remove ${dir}: ${getErrorMessage(err)}`)
      );
    },
  };
}

/** The depth of a run's cause (a person's action is 0). */
function causeChainDepth(context: HookRunContext | undefined): number {
  return context?.chainDepth === undefined
    ? currentChainDepth()
    : normalizeChainDepth(context.chainDepth);
}

/** The hook chain of a run's cause (empty for a person's action). */
function causeHookChain(context: HookRunContext | undefined): readonly string[] {
  return context?.hookChain === undefined
    ? currentHookChain()
    : normalizeHookChain(context.hookChain);
}

/** The depth a run executes at: its cause's depth + 1 (a person's action is 0). */
export function runChainDepth(context: HookRunContext | undefined): number {
  return causeChainDepth(context) + 1;
}

/**
 * The context the child sees: everything except the server-side bookkeeping,
 * with `agentId` set to the run-as agent when there is one, so the SDK's
 * forwarded `agent_id` matches the agent its credential is bound to.
 */
function childContext(
  context: HookRunContext
): Omit<
  HookRunContext,
  'chainDepth' | 'hookChain' | 'runAsAgentId' | 'runAsBuildHash' | 'unattendedCap'
> {
  const {
    chainDepth: _depth,
    hookChain: _chain,
    unattendedCap: _cap,
    runAsBuildHash: _hash,
    runAsAgentId,
    ...rest
  } = context;
  return runAsAgentId ? { ...rest, agentId: runAsAgentId } : rest;
}

/**
 * `hook:finished` for a successful run only, emitted at the run's own
 * depth and in its chain, so a hook listening to its own finish is stopped.
 */
function emitHookFinished(
  input: {
    runId: string;
    hookName: string;
    eventName: string;
    durationMs: number;
    chainDepth: number;
  },
  chain: readonly string[]
): void {
  try {
    runAtChainDepth(input.chainDepth, () => hooks.emit('hook:finished', input), undefined, chain);
  } catch (err) {
    logger.warn(`${HOOK_LOG_PREFIX} hook:finished not emitted: ${getErrorMessage(err)}`);
  }
}

export interface HookTestRunParams {
  hookName: string;
  builtPath: string;
  hookDir: string;
  eventName: string;
  event: Record<string, unknown>;
  context?: HookRunContext;
  source?: Exclude<HookRunSource, 'event'>;
  /** @deprecated No-op; carried for compatibility. */
  repeatInChain?: boolean;
}

interface HookEventRunParams {
  hookName: string;
  builtPath: string;
  hookDir: string;
  eventName: string;
  event: Record<string, unknown>;
  context: HookRunContext;
  /** @deprecated No-op; carried for compatibility. */
  repeatInChain?: boolean;
}

/** The result a refused run reports: nothing ran. */
function refusedResult(refusal: HookChainRefusal): HookRunResult {
  return {
    ok: false,
    exitCode: null,
    durationMs: 0,
    stdout: '',
    stderr: refusal.stderr,
    timedOut: false,
  };
}

/**
 * Runs built hooks as bounded, crash-isolated child processes. One instance is
 * shared by the registry; tests can construct their own with a mock serverUrl.
 */
export class HookRunner {
  private readonly serverUrl: string;
  private readonly timeoutMs: number;
  private readonly semaphore: Semaphore;
  /**
   * Slots for nested runs only. A hook that waits on snaglet.hooks.run holds its
   * own slot, so a chain of them (A → B → C → D → E) would fill the shared
   * semaphore and deadlock until the timeouts. A nested run never waits: it
   * takes one of these, else a free shared slot, else it is refused.
   */
  private readonly nestedSlots: Semaphore;
  private readonly concurrency: number;
  private readonly recorder: HookRunRecorder | undefined;
  private readonly limits: () => Promise<HookChainLimits>;
  private readonly checkRunAs: (agentId: string) => Promise<string | null>;
  private readonly guard = new HookChainGuard();
  /** In-flight run promises — tracked so tests (and shutdown) can await them. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(opts: HookRunnerOptions) {
    this.serverUrl = opts.serverUrl;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    this.concurrency = Math.max(1, opts.concurrency ?? DEFAULT_HOOK_CONCURRENCY);
    this.semaphore = new Semaphore(this.concurrency);
    this.nestedSlots = new Semaphore(this.concurrency);
    this.recorder = opts.recorder;
    this.limits = opts.limits ?? (() => Promise.resolve(DEFAULT_HOOK_CHAIN_LIMITS));
    this.checkRunAs = opts.checkRunAs ?? checkHookRunAsAgent;
  }

  /**
   * Fire a hook for one event. Returns a promise that resolves when the child
   * exits (or is killed), but the caller is expected not to await it (observers
   * are fire-and-forget). Never rejects.
   */
  run(params: HookEventRunParams): Promise<void> {
    // Count the invocation before the semaphore wait. A destructive clear or
    // delete must conflict with queued work as well as an already-spawned child.
    if (!hookExecutionCoordinator.begin(params.hookName)) return Promise.resolve();
    const promise = this.runInternal(params).finally(() => {
      hookExecutionCoordinator.end(params.hookName);
      this.inFlight.delete(promise);
    });
    this.inFlight.add(promise);
    return promise;
  }

  /**
   * Run a saved hook and return its process result. Used by the Hook Builder's
   * explicit test action and by durable schedules. It shares the same
   * semaphore, timeout, safe environment, and per-spawn child credential as
   * ordinary lifecycle dispatches; there is no second execution substrate.
   */
  async runForTest(params: HookTestRunParams): Promise<HookRunResult> {
    if (!hookExecutionCoordinator.begin(params.hookName)) {
      return {
        ok: false,
        exitCode: null,
        durationMs: 0,
        stdout: '',
        stderr: `Hook "${params.hookName}" is being cleared or deleted`,
        timedOut: false,
      };
    }
    try {
      return await this.runForTestReserved(params);
    } finally {
      hookExecutionCoordinator.end(params.hookName);
    }
  }

  private async runForTestReserved(params: HookTestRunParams): Promise<HookRunResult> {
    const context = params.context ?? {};
    const source = params.source ?? 'manual';
    // Read the cause before any await. A run with a hook chain was started by
    // running hook code, which waits for it while it holds a slot (nested).
    const causeDepth = causeChainDepth(context);
    const causeChain = causeHookChain(context);
    const unattendedCap = causeUnattendedCap(context);
    const nested = causeChain.length > 0;
    const runAsRefusal = await this.runAsRefusal(context, params.builtPath);
    if (runAsRefusal) {
      return this.refuseRunAs(runAsRefusal, params.hookName, params.eventName, source, context, {
        chainDepth: causeDepth + 1,
      });
    }
    const verdict = this.guard.check(
      {
        hookName: params.hookName,
        source,
        causeDepth,
        causeChain,
        repeatInChain: params.repeatInChain === true,
        nested,
      },
      await this.limits()
    );
    if (!verdict.allowed) {
      return this.refuse(verdict, params.hookName, params.eventName, source, context);
    }
    let release: () => void;
    if (nested) {
      const slot = this.nestedSlots.tryAcquire() ?? this.semaphore.tryAcquire();
      if (!slot) {
        verdict.uncount();
        const refusal = this.guard.refuse(
          'slots',
          params.hookName,
          verdict.depth,
          verdict.chain,
          `all ${this.concurrency} nested-run slots and all ${this.concurrency} hook slots are ` +
            'in use, and a nested run never waits for one (it would deadlock the hooks waiting on it)'
        );
        return this.refuse(refusal, params.hookName, params.eventName, source, context);
      }
      release = slot;
    } else {
      release = await this.semaphore.acquire();
    }
    const t0 = Date.now();
    // Registered after the semaphore acquire (a hook queued behind the
    // concurrency cap isn't working yet); unregistered in the same finally
    // that releases the slot, so timeout/kill/spawn-error can't leak an entry.
    const workId = `hook-run-${randomUUID()}`;
    const { depth: chainDepth, chain } = verdict;
    try {
      await this.recordStart({
        id: workId,
        hookName: params.hookName,
        source,
        eventName: params.eventName,
        ...recordedAgent(context),
        ...(context.threadId ? { threadId: context.threadId } : {}),
        chainDepth,
      });
      activeWorkRegistry.registerHookRun({
        id: workId,
        hookName: params.hookName,
        ...recordedAgent(context),
        ...(context.threadId ? { threadId: context.threadId } : {}),
      });
      let runResult: HookRunResult;
      try {
        const bundle = await startableBundle(params.builtPath, params.hookName, context);
        let result: SpawnResult;
        try {
          result = await spawnHookProcess({
            builtPath: bundle.path,
            args: [],
            cwd: params.hookDir,
            env: buildToolEnv({
              SNAGLET_SERVER_URL: this.serverUrl,
              SNAGLET_HOOK_NAME: params.hookName,
              SNAGLET_TOOL_CONTEXT_JSON: JSON.stringify(childContext(context)),
              SNAGLET_CHAIN_DEPTH: String(chainDepth),
              // Agentless events (task moves, schedules, thread creates) bind the
              // ghost system actor — an unbound credential can never execute
              // tools (execution.routes.ts invariant), which would silently break
              // every tool-using hook outside an agent turn.
              SNAGLET_CHILD_DISPATCH_TOKEN: mintChildDispatchToken(
                actingAgentId(context),
                params.hookName,
                chainDepth,
                chain,
                unattendedCap,
                Boolean(context.runAsAgentId),
                context.threadId
              ),
            }),
            stdin: JSON.stringify({ event: { ...params.event, type: params.eventName } }),
            timeoutMs: this.timeoutMs,
          });
        } finally {
          await bundle.dispose();
        }
        runResult = {
          ok: !result.timedOut && result.code === 0,
          exitCode: result.code,
          durationMs: elapsedMs(t0),
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
        };
      } catch (err) {
        runResult = {
          ok: false,
          exitCode: null,
          durationMs: elapsedMs(t0),
          stdout: '',
          stderr: getErrorMessage(err),
          timedOut: false,
        };
      }
      await this.recordFinish(workId, runResult);
      if (runResult.ok) {
        emitHookFinished(
          {
            runId: workId,
            hookName: params.hookName,
            eventName: params.eventName,
            durationMs: runResult.durationMs,
            chainDepth,
          },
          chain
        );
      }
      return runResult;
    } finally {
      activeWorkRegistry.unregister(workId);
      release();
    }
  }

  private async runInternal(params: HookEventRunParams): Promise<void> {
    const { hookName, builtPath, hookDir, eventName, event, context } = params;
    // Read the cause before any await. An event run is fire-and-forget (nobody
    // waits on it), so it may queue for a shared slot; the gate runs first, so
    // a refused run never queues.
    const unattendedCap = causeUnattendedCap(context);
    const request = {
      hookName,
      source: 'event' as const,
      causeDepth: causeChainDepth(context),
      causeChain: causeHookChain(context),
      repeatInChain: params.repeatInChain === true,
      nested: false,
    };
    const runAsRefusal = await this.runAsRefusal(context, builtPath);
    if (runAsRefusal) {
      await this.refuseRunAs(runAsRefusal, hookName, eventName, 'event', context, {
        chainDepth: request.causeDepth + 1,
      });
      return;
    }
    const verdict = this.guard.check(request, await this.limits());
    if (!verdict.allowed) {
      await this.refuse(verdict, hookName, eventName, 'event', context);
      return;
    }
    const release = await this.semaphore.acquire();
    const t0 = Date.now();
    // Same lifecycle as runForTest: register once the hook actually holds an
    // execution slot; the finally below removes the entry on every exit path.
    const workId = `hook-run-${randomUUID()}`;
    const { depth: chainDepth, chain } = verdict;
    try {
      await this.recordStart({
        id: workId,
        hookName,
        source: 'event',
        eventName,
        ...recordedAgent(context),
        ...(context.threadId ? { threadId: context.threadId } : {}),
        chainDepth,
      });
      activeWorkRegistry.registerHookRun({
        id: workId,
        hookName,
        ...recordedAgent(context),
        ...(context.threadId ? { threadId: context.threadId } : {}),
      });
      let runResult: HookRunResult;
      try {
        const bundle = await startableBundle(builtPath, hookName, context);
        let result: SpawnResult;
        try {
          result = await spawnHookProcess({
            builtPath: bundle.path,
            args: [],
            cwd: hookDir,
            env: buildToolEnv({
              SNAGLET_SERVER_URL: this.serverUrl,
              SNAGLET_HOOK_NAME: hookName,
              SNAGLET_TOOL_CONTEXT_JSON: JSON.stringify(childContext(context)),
              SNAGLET_CHAIN_DEPTH: String(chainDepth),
              // Hooks run user-authored observer code, so — exactly like
              // workspace tools (see ToolExecutor.ts) — they get only a narrow,
              // per-spawn child-dispatch credential (panelAuth.ts), never a copy
              // of the full panel token. Minted fresh here, bound to
              // `context.agentId` (the invoking agent) rather than a single
              // process-wide secret every hook shares, so this child cannot
              // raw-fetch /execute with a forged agent_id and run tools as a
              // different agent. This lets the hook's @snaglet/sdk call back into
              // /api/tools/execute to run a normal tool as this agent, but grants
              // no act_as impersonation authority and no access to
              // /execute/test's arbitrary-code sandbox. Agentless events bind
              // the ghost system actor instead of an unbound (tool-incapable)
              // credential — see the run-site note above.
              SNAGLET_CHILD_DISPATCH_TOKEN: mintChildDispatchToken(
                actingAgentId(context),
                hookName,
                chainDepth,
                chain,
                unattendedCap,
                Boolean(context.runAsAgentId),
                context.threadId
              ),
            }),
            stdin: JSON.stringify({ event }),
            timeoutMs: this.timeoutMs,
          });
        } finally {
          await bundle.dispose();
        }

        const durationMs = elapsedMs(t0);
        const as = context.runAsAgentId ? ` as=${context.runAsAgentId}` : '';
        runResult = {
          ok: !result.timedOut && result.code === 0,
          exitCode: result.code,
          durationMs,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
        };
        if (result.timedOut) {
          logger.warn(
            `${HOOK_LOG_PREFIX} "${hookName}"${as} event=${eventName} duration=${durationMs}ms KILLED (timeout ${this.timeoutMs}ms)`
          );
        } else if (result.code !== 0) {
          const details = result.stderr.trim() || result.stdout.trim() || 'no output';
          logger.warn(
            `${HOOK_LOG_PREFIX} "${hookName}"${as} event=${eventName} duration=${durationMs}ms exit=${result.code}: ${details.slice(0, 500)}`
          );
        } else {
          logger.info(
            `${HOOK_LOG_PREFIX} "${hookName}"${as} event=${eventName} duration=${durationMs}ms exit=0`
          );
        }
      } catch (err) {
        // Spawn-level failure (e.g. node missing) — logged, swallowed.
        runResult = {
          ok: false,
          exitCode: null,
          durationMs: elapsedMs(t0),
          stdout: '',
          stderr: getErrorMessage(err),
          timedOut: false,
        };
        logger.error(
          `${HOOK_LOG_PREFIX} "${hookName}" event=${eventName} spawn failed: ${getErrorMessage(err)}`
        );
      }
      await this.recordFinish(workId, runResult);
      if (runResult.ok) {
        emitHookFinished(
          {
            runId: workId,
            hookName,
            eventName,
            durationMs: runResult.durationMs,
            chainDepth,
          },
          chain
        );
      }
    } finally {
      activeWorkRegistry.unregister(workId);
      release();
    }
  }

  /**
   * A refused run: nothing spawns and no `hook:finished` is sent. The first
   * refusal per hook and limit in a minute is recorded as a failed run with
   * duration 0 and no exit code; the guard counts the rest.
   */
  private async refuse(
    refusal: HookChainRefusal,
    hookName: string,
    eventName: string,
    source: HookRunSource,
    context: HookRunContext
  ): Promise<HookRunResult> {
    const result = refusedResult(refusal);
    if (!refusal.record) return result;
    logger.warn(`${HOOK_LOG_PREFIX} "${hookName}" event=${eventName} ${refusal.stderr}`);
    const id = `hook-run-${randomUUID()}`;
    await this.recordStart({
      id,
      hookName,
      source,
      eventName,
      ...recordedAgent(context),
      ...(context.threadId ? { threadId: context.threadId } : {}),
      chainDepth: refusal.depth,
    });
    await this.recordFinish(id, result);
    return result;
  }

  /**
   * Why a run may not act as its run-as agent, or null (also when it has
   * none): the agent is gone, archived or a helper, or the bundle on disk is
   * not the one run as was approved for.
   */
  private async runAsRefusal(context: HookRunContext, builtPath: string): Promise<string | null> {
    const agentId = context.runAsAgentId;
    if (!agentId) return null;
    try {
      const problem = await this.checkRunAs(agentId);
      if (problem) return problem;
      if (!context.runAsBuildHash) return 'no approved build is recorded for it';
      const onDisk = createHash('sha256')
        .update(await readFile(builtPath))
        .digest('hex');
      return onDisk === context.runAsBuildHash
        ? null
        : "the hook's built code changed since Run as was set";
    } catch (err) {
      return `its agent or build could not be checked (${getErrorMessage(err)})`;
    }
  }

  /**
   * A run whose run-as agent can no longer be used: nothing spawns, and the
   * run is recorded as failed with the reason, every time (a person has to
   * pick another agent or clear the setting, and the run log is where they
   * see it). It never falls back to another identity.
   */
  private async refuseRunAs(
    problem: string,
    hookName: string,
    eventName: string,
    source: HookRunSource,
    context: HookRunContext,
    at: { chainDepth: number }
  ): Promise<HookRunResult> {
    const result: HookRunResult = {
      ok: false,
      exitCode: null,
      durationMs: 0,
      stdout: '',
      stderr:
        `Refused before running: hook "${hookName}" is set to run as ${context.runAsAgentId}, ` +
        `but ${problem}. Pick another agent or clear Run as in the hook editor.`,
      timedOut: false,
    };
    logger.warn(`${HOOK_LOG_PREFIX} "${hookName}" event=${eventName} ${result.stderr}`);
    const id = `hook-run-${randomUUID()}`;
    await this.recordStart({
      id,
      hookName,
      source,
      eventName,
      ...recordedAgent(context),
      ...(context.threadId ? { threadId: context.threadId } : {}),
      chainDepth: at.chainDepth,
    });
    await this.recordFinish(id, result);
    return result;
  }

  private async recordStart(input: HookRunStartRecord): Promise<void> {
    try {
      await this.recorder?.start(input);
    } catch (err) {
      logger.warn(`${HOOK_LOG_PREFIX} run recorder start failed: ${getErrorMessage(err)}`);
    }
  }

  private async recordFinish(id: string, result: HookRunResult): Promise<void> {
    try {
      await this.recorder?.finish(id, result);
    } catch (err) {
      logger.warn(`${HOOK_LOG_PREFIX} run recorder finish failed: ${getErrorMessage(err)}`);
    }
  }

  /** Await all currently in-flight hook runs (used by tests + graceful shutdown). */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  /** Log the refusals the chain guard is still counting (shutdown, tests). */
  flushRefusals(): void {
    this.guard.flush();
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }
}
