/**
 * runContext — ambient run provenance for agent tool execution.
 *
 * Parallel to actorContext (which carries who). This carries the run
 * coordinates (which thread / run) so anything firing during an agent tool
 * call (dispatch, automations, subagents, hook events) can attribute the work
 * to its originating thread without threading params through every signature. Bound
 * by the tool dispatcher around each tool execution; absent for human HTTP
 * mutations (thread_id stays null for those, by design).
 *
 * `chainDepth` is how many automated hops separate this work
 * from a person's action. A person's action is 0; a hook run or a woken agent
 * is its cause's depth + 1. Every hook event is stamped with the depth current
 * at emit time, so loop stops can refuse events that are too deep without a
 * column on every table. Depth crosses process boundaries explicitly: hook and
 * tool children get it inside their signed child-dispatch token (and as
 * `SNAGLET_CHAIN_DEPTH` for the hook's own information), never by inheritance.
 *
 * `hookChain` travels the same way: the ordered names of the hooks whose runs
 * led here (A → B → …). It is recorded on every run for visibility; Snaglet does
 * not refuse a hook for already appearing in the chain. The chain guard
 * (customHooks/hookChainGuard.ts) reads it only for the run record and for
 * the nested self-run block.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { UnattendedWake } from '@snaglet/shared/types';

/** A hook as the cause of an event (`origin` on hook payloads). */
export interface HookOrigin {
  kind: 'hook';
  hookName: string;
}

export interface RunContext {
  threadId?: string | null;
  runId?: string | null;
  /** Automated hops from a person's action (0 = a person did this). */
  chainDepth?: number;
  /**
   * Names of the hooks whose runs led here, oldest first (empty = none).
   * Inherited like `chainDepth`; crosses into children inside the signed
   * dispatch token.
   */
  hookChain?: readonly string[];
  /**
   * The hook whose tool call this is (POST /api/tools/execute from a hook's
   * child, named by its signed token), so events the call causes can name
   * it as their `origin` and the self-origin guard keeps that hook from
   * firing on its own writes. Not inherited by {@link runWithRunContext}: an
   * agent run a hook wakes acts as the agent.
   */
  hookOrigin?: HookOrigin;
  /**
   * The unattended marker of the dispatch this work belongs to (an automation
   * or a hook started it). Bound by dispatchToThread for the whole wave and
   * inherited like `hookChain`, so a dispatch started from inside it (a
   * helper, a thread send, a result wake) knows it is downstream of an
   * unattended run.
   */
  unattended?: UnattendedWake;
  /**
   * Whatever runs here may not auto-approve: an agent started or caused it,
   * or a person's message rides in the same wave. Inherited like `hookChain`;
   * crosses into hook children inside the signed dispatch token.
   */
  unattendedCap?: boolean;
}

/** Most names a chain carries; longer chains keep the latest entries. Depth
 * (a plain counter) keeps counting past this — the chain list is for display. */
export const MAX_HOOK_CHAIN_LENGTH = 32;
/** Longest name a chain entry keeps; longer hook names are cut to this. */
export const MAX_HOOK_CHAIN_NAME_LENGTH = 128;

const storage = new AsyncLocalStorage<RunContext>();

/** Run `fn` with `ctx` bound as the ambient run provenance for the duration. */
export function runWithRunContext<T>(ctx: RunContext, fn: () => T): T {
  // A nested binding that doesn't name a depth (or a chain) keeps the
  // enclosing one, so a tool dispatched inside a woken (depth > 0) run never
  // resets to 0.
  const enclosing = storage.getStore();
  const bound: RunContext = { ...ctx };
  if (ctx.chainDepth === undefined && enclosing?.chainDepth !== undefined) {
    bound.chainDepth = enclosing.chainDepth;
  }
  if (ctx.hookChain === undefined && enclosing?.hookChain !== undefined) {
    bound.hookChain = enclosing.hookChain;
  }
  if (ctx.unattended === undefined && enclosing?.unattended !== undefined) {
    bound.unattended = enclosing.unattended;
  }
  // The cap only ever tightens: a nested binding can't clear it.
  if (enclosing?.unattendedCap) bound.unattendedCap = true;
  return storage.run(bound, fn);
}

/** True when the current work may not auto-approve (see RunContext.unattendedCap). */
export function currentUnattendedCap(): boolean {
  return storage.getStore()?.unattendedCap === true;
}

/** Run `fn` as part of the dispatch whose unattended marker is `unattended`. */
export function runWithUnattended<T>(unattended: UnattendedWake, fn: () => T): T {
  return storage.run({ ...storage.getStore(), unattended }, fn);
}

/**
 * Set the cap on the current context for the rest of the work bound to it (a
 * running agent was handed a capped message mid-run). Never cleared. A no-op
 * (false) when nothing is bound.
 */
export function raiseAmbientUnattendedCap(): boolean {
  const store = storage.getStore();
  if (!store) return false;
  store.unattendedCap = true;
  return true;
}

/** Run `fn` with the unattended cap set (it never auto-approves). */
export function runCappedUnattended<T>(fn: () => T): T {
  return storage.run({ ...storage.getStore(), unattendedCap: true }, fn);
}

/** Normalize an untrusted depth value to a non-negative integer (0 when invalid). */
export function normalizeChainDepth(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/** The chain depth of the current async context (0 when nothing bound one). */
export function currentChainDepth(): number {
  return normalizeChainDepth(storage.getStore()?.chainDepth);
}

/** Normalize an untrusted chain to its string entries (empty when invalid). */
export function normalizeHookChain(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((name): name is string => typeof name === 'string' && name.length > 0);
}

/** The hook chain of the current async context (empty when nothing bound one). */
export function currentHookChain(): readonly string[] {
  return normalizeHookChain(storage.getStore()?.hookChain);
}

/** `chain` with `hookName` appended: the chain a run of that hook executes in. */
export function extendHookChain(chain: readonly string[], hookName: string): readonly string[] {
  return [...chain, hookName.slice(0, MAX_HOOK_CHAIN_NAME_LENGTH)].slice(-MAX_HOOK_CHAIN_LENGTH);
}

/**
 * Run `fn` at an explicit chain depth, keeping the rest of the bound context;
 * with `hookOrigin`, as that hook's tool call ({@link RunContext.hookOrigin});
 * with `hookChain`, in that chain (otherwise the enclosing one is kept).
 */
export function runAtChainDepth<T>(
  chainDepth: number,
  fn: () => T,
  hookOrigin?: HookOrigin,
  hookChain?: readonly string[]
): T {
  return storage.run(
    {
      ...storage.getStore(),
      chainDepth: normalizeChainDepth(chainDepth),
      ...(hookOrigin ? { hookOrigin } : {}),
      ...(hookChain ? { hookChain: normalizeHookChain(hookChain) } : {}),
    },
    fn
  );
}

/**
 * Run `fn` in its own copy of the enclosing context, so a later
 * {@link raiseAmbientChainContext} inside it stays local to `fn` (one agent's
 * run) and never leaks into the caller or a sibling run of the same wave.
 */
export function runInOwnChainScope<T>(fn: () => T): T {
  return storage.run({ ...storage.getStore() }, fn);
}

/**
 * Raise the current context's depth and chain in place, for the rest of the
 * work bound to it (a run that acts on an injected hook message acts
 * at that message's depth). The depth never decreases; the caller supplies the
 * already-merged chain. A no-op (false) when nothing is bound.
 */
export function raiseAmbientChainContext(
  chainDepth: number,
  hookChain: readonly string[]
): boolean {
  const store = storage.getStore();
  if (!store) return false;
  store.chainDepth = Math.max(
    normalizeChainDepth(store.chainDepth),
    normalizeChainDepth(chainDepth)
  );
  store.hookChain = normalizeHookChain(hookChain).slice(-MAX_HOOK_CHAIN_LENGTH);
  return true;
}

/** The hook whose tool call the current async context is, if any. */
export function currentHookOrigin(): HookOrigin | undefined {
  return storage.getStore()?.hookOrigin;
}

/** Get the ambient run provenance, or `undefined` if none is bound. */
export function getRunContext(): RunContext | undefined {
  return storage.getStore();
}
