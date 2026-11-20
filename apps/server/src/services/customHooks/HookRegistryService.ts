/**
 * HookRegistryService — folder-drop registration for user-defined lifecycle
 * hooks.
 *
 * A user drops `<snaglet-home>/hooks/<name>/hook.ts` that default-exports
 * `defineHook({ on?, schedule?, filter?, run })`. On boot and on change the server:
 *   1. builds it (virtual SDK + esbuild → `dist/hook.cjs`, see buildHookBundle),
 *   2. discovers `on`/`filter`/`schedule` in `--describe` mode,
 *   3. subscribes lifecycle events and reconciles durable schedule rows,
 *   4. runs matching events as bounded child processes (HookRunner).
 * Removing/renaming the folder unregisters it; editing it hot-reloads.
 *
 * This is the SECOND FolderScanner instance in the codebase — it reuses the
 * generic scanner (scan-at-boot + debounced watch, crash-isolated) and the shared
 * vendor-SDK bundler, exactly as the scanner was designed for.
 *
 * Hooks are OBSERVERS: dispatch is fire-and-forget and never blocks the emitter;
 * a hook that throws or hangs is logged/killed and the message flow is unaffected.
 */

import { readFile, stat } from 'fs/promises';
import { createHash } from 'node:crypto';
import path from 'path';
import { logger } from '@server/config/logger';
import { getErrorMessage } from '@snaglet/shared/utils';
import type { UnattendedPolicy } from '@snaglet/shared/types';
import { GHOST_AGENT_ID } from '@snaglet/shared/constants/systemAgents';
import { serverConfig } from '@server/config';
import { HookRegistrations, type HookRegistrationRow } from '@snaglet/db';
import {
  SNAGLET_HOOKS_DIR,
  SNAGLET_HOOK_BUILDS_DIR,
  SNAGLET_SDK_RUNTIME_DIR,
} from '@server/services/snagletHome';
import { FolderScanner, type ScannedFolder } from '@server/services/FolderScanner';
import { hooks, type HookEvent, type HookEventMap } from '@server/services/HookService';
import { isHelperHookEvent } from '@server/services/hooks/helperEvents';
import { currentChainDepth, currentHookChain } from '@server/realtime/runContext';
import { emitHookRegistryChanged } from '@server/realtime/surfaces/hookRuns';
import { buildHookBundle, BUILT_HOOK_RELATIVE } from './buildHookBundle';
import { bundleUsesCurrentSdk } from '@server/services/ToolService/customTools/bundleVendoredEntry';
import {
  removeLegacySdkCopy,
  SDK_RUNTIME_HASH,
} from '@server/services/ToolService/customTools/vendorSdk';
import { ensureHookAuthoringSupport } from './hookAuthoringSupport';
import { hookRunAsNotBuiltError, hookRunAsSaveError, resolveHookRunAsAgent } from './hookRunAs';
import { hookRunLedger } from './HookRunLedger';
import { readHookChainLimits } from './hookChainGuard';
import { workerSettings } from '@server/services/settings/categories/workers';
import { settingsService } from '@server/services/settings/settingsService';
import {
  HookRunner,
  describeHook,
  HOOK_LOG_PREFIX,
  type HookRunContext,
  type HookRunResult,
} from './hookRunner';

/** Canonical user-hooks directory: `<snaglet-home>/hooks`. */
export const CUSTOM_HOOKS_DIR = SNAGLET_HOOKS_DIR;

/** Files a well-formed hook folder must contain. */
export const HOOK_REQUIRED_FILES = ['hook.ts'] as const;

/** A single registered hook: its bundle + the bus listeners it owns. */
interface HookRegistration {
  name: string;
  dir: string;
  builtPath: string;
  events: HookEvent[];
  filter: Record<string, unknown> | null;
  /** Raw `schedule` declarations from defineHook (describe output), kept so
   *  the builder's test console can learn what the saved code declares. */
  schedules: unknown[];
  /** @deprecated No-op (chain repeats are never refused); carried for compatibility. */
  repeatInChain: boolean;
  /** The agent the hook runs as (`run_as_agent_id`), or null for the default. */
  runAsAgentId: string | null;
  /** The build run as was set for (`run_as_build_hash`); checked before each run. */
  runAsBuildHash: string | null;
  /** One bound listener per event so unregister can `off()` them precisely. */
  listeners: Map<HookEvent, (payload: unknown) => void>;
}

/** What a registered hook's saved code declares (describe output, in-memory). */
export interface HookDeclaredMeta {
  events: HookEvent[];
  filter: Record<string, unknown> | null;
  schedules: unknown[];
}

export interface HookRegistryOptions {
  /** Root hooks directory (defaults to `<snaglet-home>/hooks`). */
  dir?: string;
  /** Generated bundle directory (defaults to Snaglet-owned build storage). */
  buildDir?: string;
  /** URL the hook children call back into (defaults to the server's own base URL). */
  serverUrl?: string;
  /** Per-hook run timeout (ms). */
  hookTimeoutMs?: number;
  /** Describe (metadata discovery) timeout (ms). */
  describeTimeoutMs?: number;
  /** Max simultaneous hook child processes. */
  concurrency?: number;
}

/** Has the source `hook.ts` changed since the bundle was last built? */
async function bundleIsStale(builtPath: string, sources: string[]): Promise<boolean> {
  let builtMtime: number;
  try {
    builtMtime = (await stat(builtPath)).mtimeMs;
  } catch {
    return true; // no bundle yet
  }
  if (!(await bundleUsesCurrentSdk(builtPath))) return true;
  for (const src of sources) {
    try {
      if ((await stat(src)).mtimeMs > builtMtime) return true;
    } catch {
      return true; // a source vanished — force a rebuild attempt
    }
  }
  return false;
}

/** Coerce a described `on` value into a de-duped list of valid event names. */
function normalizeEvents(on: unknown): HookEvent[] {
  const raw = Array.isArray(on) ? on : [on];
  const seen = new Set<HookEvent>();
  for (const value of raw) {
    if (typeof value === 'string' && value.length > 0) seen.add(value as HookEvent);
  }
  return [...seen];
}

/** A run's context with the hook's run-as agent, which wins over the event's agent. */
function withRunAs(
  context: HookRunContext | undefined,
  registration: Pick<HookRegistration, 'runAsAgentId' | 'runAsBuildHash'>
): HookRunContext | undefined {
  if (!registration.runAsAgentId) return context;
  return {
    ...(context ?? {}),
    runAsAgentId: registration.runAsAgentId,
    ...(registration.runAsBuildHash ? { runAsBuildHash: registration.runAsBuildHash } : {}),
  };
}

/**
 * Whether an on-demand run (the test console, `hook` op `run`,
 * `snaglet.hooks.run`) acts as the hook's run-as agent. Only an enabled hook, and
 * only for a person (no calling agent) or the run-as agent itself: any other
 * agent runs it as itself, so nobody borrows another agent's access by
 * running a hook that was set to act as it.
 */
export function onDemandRunsAs(
  runAsAgentId: string | null,
  enabled: boolean,
  callerAgentId: string | undefined
): boolean {
  if (!runAsAgentId || !enabled) return false;
  return !callerAgentId || callerAgentId === runAsAgentId;
}

/**
 * An agent's own message (`message:create` with role `agent`) or one of its
 * runs (`run:*`) caused this event. The ghost agent is a hook's sender.
 */
function agentCausedEvent(eventName: string, record: Record<string, unknown>): boolean {
  const agentId = record.agentId;
  if (typeof agentId !== 'string' || !agentId || agentId === GHOST_AGENT_ID) return false;
  return (
    (eventName === 'message:create' && record.role === 'agent') || eventName.startsWith('run:')
  );
}

export class HookRegistryService {
  readonly dir: string;
  readonly buildDir: string;
  private readonly describeTimeoutMs: number | undefined;
  private readonly runner: HookRunner;
  private readonly registrations = new Map<string, HookRegistration>();
  /** Names whose source folder is intentionally quarantined by the delete API. */
  private readonly managedDeletes = new Set<string>();
  private scanner: FolderScanner | undefined;

  constructor(opts: HookRegistryOptions = {}) {
    this.dir = opts.dir ?? CUSTOM_HOOKS_DIR;
    this.buildDir =
      opts.buildDir ?? (opts.dir ? path.join(opts.dir, '.snaglet-build') : SNAGLET_HOOK_BUILDS_DIR);
    this.describeTimeoutMs = opts.describeTimeoutMs;
    this.runner = new HookRunner({
      serverUrl: opts.serverUrl ?? serverConfig.apiBaseUrl,
      timeoutMs: opts.hookTimeoutMs,
      concurrency: opts.concurrency,
      recorder: hookRunLedger,
      limits: readHookChainLimits,
    });
  }

  /** Expose the runner so tests (and shutdown) can await in-flight hook runs. */
  getRunner(): HookRunner {
    return this.runner;
  }

  /** Names of currently-registered hooks (diagnostics/tests). */
  get registeredHookNames(): string[] {
    return [...this.registrations.keys()];
  }

  beginManagedDelete(hookName: string): void {
    this.managedDeletes.add(hookName);
    // Stop new event dispatch synchronously. The HookRunner coordinator is the
    // second gate for callbacks already queued behind the settings read.
    this.unregisterHook(hookName);
  }

  finishManagedDelete(hookName: string): void {
    this.managedDeletes.delete(hookName);
  }

  async cancelManagedDelete(hookName: string): Promise<void> {
    this.managedDeletes.delete(hookName);
    await this.registerHookFolder(hookName);
  }

  isManagedDelete(hookName: string): boolean {
    return this.managedDeletes.has(hookName);
  }

  async listRegistrations(): Promise<HookRegistrationRow[]> {
    return HookRegistrations.listAll();
  }

  /**
   * Declared triggers/schedules for a currently-registered hook, straight from
   * the in-memory registration (describe output). Null when the hook isn't
   * registered — e.g. its build failed — so callers can distinguish "no
   * declarations" from "nothing runnable".
   */
  getDeclaredMeta(hookName: string): HookDeclaredMeta | null {
    const registration = this.registrations.get(hookName);
    if (!registration) return null;
    return {
      events: [...registration.events],
      filter: registration.filter,
      schedules: [...registration.schedules],
    };
  }

  /**
   * What a run this hook wakes does with a tool call that would ask (see
   * UnattendedPolicy). A setting on the registration only: it changes no
   * build or registration state, so nothing is rebuilt.
   */
  async setUnattendedPolicy(
    hookName: string,
    policy: UnattendedPolicy
  ): Promise<HookRegistrationRow | null> {
    return HookRegistrations.setUnattendedPolicy(hookName, policy);
  }

  async setEnabled(hookName: string, enabled: boolean): Promise<HookRegistrationRow | null> {
    const row = await HookRegistrations.setEnabled(hookName, enabled);
    if (!row) return null;
    await this.registerHookFolder(hookName);
    return HookRegistrations.findByName(hookName);
  }

  /**
   * Build/register if necessary, then execute the saved hook with captured
   * output. `callerAgentId` is the agent asking for the run (none for a
   * person); see onDemandRunsAs for when it acts as the run-as agent.
   */
  async runForTest(input: {
    hookName: string;
    eventName: string;
    event: Record<string, unknown>;
    context?: HookRunContext;
    callerAgentId?: string;
  }): Promise<HookRunResult> {
    await this.registerHookFolder(input.hookName);
    const registration = this.registrations.get(input.hookName);
    if (!registration) {
      return {
        ok: false,
        exitCode: null,
        durationMs: 0,
        stdout: '',
        stderr: `Hook "${input.hookName}" could not be built or registered`,
        timedOut: false,
      };
    }
    return this.runner.runForTest({
      hookName: registration.name,
      builtPath: registration.builtPath,
      hookDir: registration.dir,
      eventName: input.eventName,
      event: input.event,
      context: onDemandRunsAs(
        registration.runAsAgentId,
        (await HookRegistrations.findByName(registration.name))?.enabled === true,
        input.callerAgentId
      )
        ? withRunAs(input.context, registration)
        : input.context,
      source: 'manual',
      repeatInChain: registration.repeatInChain,
    });
  }

  /** Automatic schedule execution obeys the durable database activation gate. */
  async runAutomatic(input: {
    hookName: string;
    eventName: string;
    event: Record<string, unknown>;
    context?: HookRunContext;
  }): Promise<HookRunResult> {
    if (!(await settingsService.read(workerSettings.hooksEnabled))) {
      return {
        ok: false,
        exitCode: null,
        durationMs: 0,
        stdout: '',
        stderr: 'Background lifecycle hooks are disabled in Settings',
        timedOut: false,
      };
    }
    const row = await HookRegistrations.findByName(input.hookName);
    if (!row?.enabled || row.buildStatus !== 'ready') {
      return {
        ok: false,
        exitCode: null,
        durationMs: 0,
        stdout: '',
        stderr: `Hook "${input.hookName}" is disabled or not build-ready`,
        timedOut: false,
      };
    }
    await this.registerHookFolder(input.hookName);
    const registration = this.registrations.get(input.hookName);
    if (!registration) {
      return {
        ok: false,
        exitCode: null,
        durationMs: 0,
        stdout: '',
        stderr: `Hook "${input.hookName}" could not be built or registered`,
        timedOut: false,
      };
    }
    return this.runner.runForTest({
      hookName: registration.name,
      builtPath: registration.builtPath,
      hookDir: registration.dir,
      eventName: input.eventName,
      event: input.event,
      context: withRunAs(input.context, registration),
      source: 'schedule',
      repeatInChain: registration.repeatInChain,
    });
  }

  /**
   * Register (or hot-reload) a single hook folder: build if stale → describe →
   * (re)subscribe to the bus. Never throws — a malformed hook is logged with a
   * clear prefix and left unregistered; the server stays healthy. Lists hear
   * `hook.registry_changed` when a build starts and when this pass ends,
   * whatever it ended in.
   */
  async registerHookFolder(folderName: string): Promise<void> {
    if (this.managedDeletes.has(folderName)) return;
    try {
      await this.registerHookFolderNow(folderName);
    } finally {
      emitHookRegistryChanged([folderName]);
    }
  }

  private async registerHookFolderNow(folderName: string): Promise<void> {
    const folderPath = path.join(this.dir, folderName);
    const hookSource = path.join(folderPath, 'hook.ts');
    const legacyBuiltPath = path.join(folderPath, BUILT_HOOK_RELATIVE);
    const builtPath = path.join(this.buildDir, folderName, 'hook.cjs');
    let legacyBuildExists = false;
    try {
      await stat(legacyBuiltPath);
      legacyBuildExists = true;
    } catch {
      // A hook with no in-folder build (older layout) registers disabled.
    }
    await removeLegacySdkCopy(folderPath);
    let row = await HookRegistrations.discover({
      id: `hook_${createHash('sha256').update(folderName).digest('hex').slice(0, 24)}`,
      name: folderName,
      sourcePath: hookSource,
      enabledForFirstRegistration: legacyBuildExists,
    });
    let builtNow = false;

    if (await bundleIsStale(builtPath, [hookSource])) {
      // Never keep dispatching an older executable while newer source is
      // building or failed. The durable enabled preference is preserved.
      this.unregisterHook(folderName);
      await HookRegistrations.setBuildState(folderName, {
        buildStatus: 'building',
        lastError: null,
      });
      emitHookRegistryChanged([folderName]);
      logger.info(`${HOOK_LOG_PREFIX} building "${folderName}"...`);
      const built = await buildHookBundle(folderPath, builtPath);
      if (!built.success) {
        logger.error(
          `${HOOK_LOG_PREFIX} BUILD FAILED for "${folderName}":\n${built.error ?? 'unknown error'}`
        );
        await HookRegistrations.setBuildState(folderName, {
          buildStatus: 'failed',
          lastError: built.error ?? 'Unknown build error',
        });
        this.unregisterHook(folderName, true);
        return;
      }
      builtNow = true;
      logger.info(`${HOOK_LOG_PREFIX} built "${folderName}" in ${built.durationMs}ms`);
    }

    const meta = await describeHook(builtPath, folderPath, this.describeTimeoutMs);
    if (!meta) {
      logger.error(
        `${HOOK_LOG_PREFIX} "${folderName}": could not read hook metadata (--describe) — left unregistered`
      );
      await HookRegistrations.setBuildState(folderName, {
        buildStatus: 'failed',
        lastError: 'Could not read hook metadata',
      });
      this.unregisterHook(folderName, true);
      return;
    }

    const events = normalizeEvents(meta.on);
    if (events.length === 0 && meta.schedule.length === 0) {
      logger.error(
        `${HOOK_LOG_PREFIX} "${folderName}": defineHook requires on or schedule — left unregistered`
      );
      await HookRegistrations.setBuildState(folderName, {
        buildStatus: 'failed',
        lastError: 'defineHook requires on or schedule',
      });
      this.unregisterHook(folderName, true);
      return;
    }

    // Replace any prior registration (hot-reload) before subscribing the new one.
    this.unregisterHook(folderName);

    const registration: HookRegistration = {
      name: folderName,
      dir: folderPath,
      builtPath,
      events,
      filter: meta.filter,
      schedules: meta.schedule,
      repeatInChain: meta.repeatInChain,
      runAsAgentId: row.runAsAgentId ?? null,
      runAsBuildHash: row.runAsBuildHash ?? null,
      listeners: new Map(),
    };
    const [sourceBytes, buildBytes] = await Promise.all([
      readFile(hookSource),
      readFile(builtPath),
    ]);
    row =
      (await HookRegistrations.setBuildState(folderName, {
        buildStatus: 'ready',
        sourceHash: createHash('sha256').update(sourceBytes).digest('hex'),
        buildHash: createHash('sha256').update(buildBytes).digest('hex'),
        sdkHash: SDK_RUNTIME_HASH,
        builtPath,
        lastError: null,
        builtNow,
      })) ?? row;
    // setBuildState clears run as when the source or build changed.
    registration.runAsAgentId = row.runAsAgentId ?? null;
    registration.runAsBuildHash = row.runAsBuildHash ?? null;
    if (row.enabled) {
      for (const eventName of events) {
        const listener = (payload: unknown): void =>
          this.dispatch(registration, eventName, payload);
        hooks.on(eventName, listener as (p: HookEventMap[typeof eventName]) => void);
        registration.listeners.set(eventName, listener);
      }
    }
    this.registrations.set(folderName, registration);
    const { scheduleService } = await import('@server/services/ScheduleService');
    try {
      await scheduleService.reconcileHookSchedules(folderName, meta.schedule);
    } catch (err) {
      logger.error(
        `${HOOK_LOG_PREFIX} "${folderName}": invalid defineHook schedule: ${getErrorMessage(err)}`
      );
      this.unregisterHook(folderName, true);
      return;
    }
    logger.info(
      `${HOOK_LOG_PREFIX} registered "${folderName}" → on=[${events.join(', ')}]` +
        ` schedule=${meta.schedule.length}` +
        ` enabled=${row.enabled}` +
        (registration.runAsAgentId ? ` runAs=${registration.runAsAgentId}` : '') +
        (registration.repeatInChain ? ' repeatInChain=true' : '') +
        (registration.filter ? ` filter=${JSON.stringify(registration.filter)}` : '')
    );
  }

  /**
   * Rebuild every registered hook whose bundle is missing or stale, as after
   * Settings → Storage clears the build folder. Event dispatch runs the
   * registered bundle path as is, so without this a cleared bundle would stay
   * missing until the next boot or source edit. Never throws.
   */
  async rebuildRegisteredHooks(): Promise<void> {
    for (const name of [...this.registrations.keys()]) {
      try {
        await this.registerHookFolder(name);
      } catch (err) {
        logger.error(`${HOOK_LOG_PREFIX} rebuild failed for "${name}": ${getErrorMessage(err)}`);
      }
    }
  }

  /**
   * Set the agent a hook runs as, by id or name, or clear it with null (the
   * default: the event's agent, else the ghost system actor). Refuses an agent
   * that does not exist, is archived, is a subagent helper, or is ghost. A
   * setting on the registration only: nothing is rebuilt. It covers the build
   * registered now, so the hook must have a ready build; new code clears it.
   * Null when the hook is not registered.
   */
  async setRunAs(hookName: string, agentRef: string | null): Promise<HookRegistrationRow | null> {
    let agentId: string | null = null;
    if (agentRef !== null && agentRef.trim()) {
      const resolved = await resolveHookRunAsAgent(agentRef);
      if (!resolved.ok) throw hookRunAsSaveError(agentRef, resolved.problem);
      agentId = resolved.agent.id;
    }
    const row = await HookRegistrations.setRunAs(hookName, agentId);
    if (!row) {
      if (agentId && (await HookRegistrations.findByName(hookName))) {
        throw hookRunAsNotBuiltError(hookName);
      }
      return null;
    }
    this.applyRunAs(hookName, row);
    logger.info(
      `${HOOK_LOG_PREFIX} "${hookName}" runs as ${row.runAsAgentId ?? 'the default actor'}`
    );
    return row;
  }

  /** Keep the in-memory registration's run as in step with its row. */
  private applyRunAs(
    hookName: string,
    row: Pick<HookRegistrationRow, 'runAsAgentId' | 'runAsBuildHash'>
  ): void {
    const registration = this.registrations.get(hookName);
    if (!registration) return;
    registration.runAsAgentId = row.runAsAgentId ?? null;
    registration.runAsBuildHash = row.runAsBuildHash ?? null;
  }

  /**
   * An agent was deleted: the database already set its hooks' run as to
   * NULL (ON DELETE SET NULL); forget it here too, so their next runs take
   * the default instead of being refused for a missing agent.
   */
  private readonly onAgentDelete = (payload: HookEventMap['agent:delete']): void => {
    for (const registration of this.registrations.values()) {
      if (registration.runAsAgentId === payload.id) {
        registration.runAsAgentId = null;
        registration.runAsBuildHash = null;
        logger.info(
          `${HOOK_LOG_PREFIX} "${registration.name}" runs as the default actor (agent ${payload.id} was deleted)`
        );
      }
    }
  };

  /** Unsubscribe a hook's bus listeners and forget it. Idempotent. */
  unregisterHook(folderName: string, removeSchedules = false): void {
    const existing = this.registrations.get(folderName);
    if (existing) {
      for (const [eventName, listener] of existing.listeners) {
        hooks.off(eventName, listener as (p: HookEventMap[typeof eventName]) => void);
      }
      this.registrations.delete(folderName);
    }
    if (removeSchedules) {
      void import('@server/services/ScheduleService').then(({ scheduleService }) =>
        scheduleService.removeHookSchedules(folderName)
      );
    }
    if (existing) logger.info(`${HOOK_LOG_PREFIX} unregistered "${folderName}"`);
  }

  /**
   * Bus listener body — runs SYNCHRONOUSLY inside `hooks.emit`, so it must never
   * throw (that would propagate into the emit site) and must never block (the
   * child spawn is fire-and-forget). Drops a subagent helper's own events (its
   * thread's messages and runs, its thread and agent lifecycle), applies the
   * pre-filter, then hands off.
   */
  private dispatch(reg: HookRegistration, eventName: HookEvent, payload: unknown): void {
    void settingsService
      .read(workerSettings.hooksEnabled)
      .then(async (enabled) => {
        if (!enabled) return;
        if (await isHelperHookEvent(eventName, payload)) return;
        this.dispatchEnabled(reg, eventName, payload);
      })
      .catch((err) => logger.warn(`${HOOK_LOG_PREFIX} failed to read hooks setting`, err));
  }

  private dispatchEnabled(reg: HookRegistration, eventName: HookEvent, payload: unknown): void {
    try {
      const record = (payload ?? {}) as Record<string, unknown>;
      const origin = record.origin as { kind?: unknown; hookName?: unknown } | undefined;
      if (origin?.kind === 'hook' && origin.hookName === reg.name) return;
      if (reg.filter) {
        for (const [key, value] of Object.entries(reg.filter)) {
          if (record[key] !== value) return; // pre-filter miss — skip before spawning
        }
      }
      const event: Record<string, unknown> = { type: eventName, ...record };
      // The run is one hop deeper than the emit that caused it, and joins its
      // chain. Read here, while the emitter's async context is still bound
      // (settings read above keeps it).
      const context: HookRunContext = {
        chainDepth: currentChainDepth(),
        hookChain: currentHookChain(),
      };
      if (typeof record.agentId === 'string') context.agentId = record.agentId;
      if (typeof record.threadId === 'string') context.threadId = record.threadId;
      if (reg.runAsAgentId) {
        context.runAsAgentId = reg.runAsAgentId;
        if (reg.runAsBuildHash) context.runAsBuildHash = reg.runAsBuildHash;
      }
      // An event an agent caused (its message or run, outside a tool call)
      // starts a run that may not auto-approve what it wakes. A hook's own
      // message is sent as the ghost agent and stays uncapped.
      if (agentCausedEvent(eventName, record)) context.unattendedCap = true;
      // Fire-and-forget: never awaited, never rejects (HookRunner is isolated).
      void this.runner.run({
        hookName: reg.name,
        builtPath: reg.builtPath,
        hookDir: reg.dir,
        eventName,
        event,
        context,
        repeatInChain: reg.repeatInChain,
      });
    } catch (err) {
      // A bug in dispatch itself must not crash the emitter.
      logger.error(
        `${HOOK_LOG_PREFIX} dispatch error for "${reg.name}" (${eventName}): ${getErrorMessage(err)}`
      );
    }
  }

  private makeScanner(): FolderScanner {
    return new FolderScanner({
      dir: this.dir,
      kind: 'custom-hooks',
      requiredFiles: [...HOOK_REQUIRED_FILES],
      onUpsert: (folder: ScannedFolder) => {
        if (this.managedDeletes.has(folder.name)) return Promise.resolve();
        return this.registerHookFolder(folder.name);
      },
      onRemove: (name: string) => {
        if (this.managedDeletes.has(name)) return Promise.resolve();
        this.unregisterHook(name, true);
        return HookRegistrations.setBuildState(name, {
          buildStatus: 'missing',
          lastError: 'Hook source is missing',
        }).then(() => emitHookRegistryChanged([name]));
      },
    });
  }

  /** One-shot reconcile (boot-without-watch + tests). Never throws. */
  async scanOnce(): Promise<void> {
    await ensureHookAuthoringSupport(
      this.dir,
      this.dir === CUSTOM_HOOKS_DIR
        ? SNAGLET_SDK_RUNTIME_DIR
        : path.join(this.dir, '.snaglet-runtime', 'sdk')
    );
    if (!this.scanner) this.scanner = this.makeScanner();
    await this.scanner.scan();
  }

  /** Boot scan + live watcher. Idempotent. */
  async start(): Promise<void> {
    await ensureHookAuthoringSupport(
      this.dir,
      this.dir === CUSTOM_HOOKS_DIR
        ? SNAGLET_SDK_RUNTIME_DIR
        : path.join(this.dir, '.snaglet-runtime', 'sdk')
    );
    if (!this.scanner) this.scanner = this.makeScanner();
    hooks.off('agent:delete', this.onAgentDelete);
    hooks.on('agent:delete', this.onAgentDelete);
    await this.scanner.start();
  }

  /** Stop watching + drop all subscriptions (shutdown / tests). */
  stop(): void {
    hooks.off('agent:delete', this.onAgentDelete);
    this.scanner?.stop();
    this.scanner = undefined;
    for (const name of [...this.registrations.keys()]) this.unregisterHook(name);
    this.runner.flushRefusals();
  }
}

// --- Module singleton + boot helpers (mirrors CustomToolScanner's surface) ----

let registry: HookRegistryService | undefined;

function ensureRegistry(): HookRegistryService {
  if (!registry) registry = new HookRegistryService();
  return registry;
}

/** Shared registry for explicit test/scheduled runs. */
export function getHookRegistry(): HookRegistryService {
  return ensureRegistry();
}

/**
 * Start the hooks scanner. Deliberately does not block the caller on building
 * every hook folder — boot calls it fire-and-forget so a pathological folder
 * can't hang `httpServer.listen` (each build + describe is independently
 * time-bounded inside registerHookFolder). Never throws.
 */
export async function startHookScanner(): Promise<void> {
  try {
    await hookRunLedger.markInterrupted();
    await ensureRegistry().start();
  } catch (err) {
    logger.warn(`${HOOK_LOG_PREFIX} scanner start failed: ${getErrorMessage(err)}`);
  }
}

/** Stop the hooks scanner + subscriptions (graceful shutdown). */
export function stopHookScanner(): void {
  registry?.stop();
  registry = undefined;
}
