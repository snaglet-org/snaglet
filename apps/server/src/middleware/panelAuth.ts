/**
 * Auth for the tool-execution routes. POST /api/tools/execute can act as any
 * agent (`act_as_agent_id`) and /execute/test runs arbitrary unsaved code. Any
 * local process can reach them, an agent's `web_fetch` included, so both need
 * a credential that no HTTP response, cookie or file on disk ever exposes.
 * Two credential classes, never interchangeable:
 * - Panel token (`X-Snaglet-Panel-Token`): full authority over both routes.
 * - Child-dispatch token (`X-Snaglet-Child-Dispatch-Token`): minted per spawn for
 *   server-spawned tool and hook code, signed to one agent; /execute only.
 */

import { randomBytes, timingSafeEqual, createHmac } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { ErrorCode } from '@snaglet/shared/types';
import { AuthError } from '@snaglet/shared/utils';
import { MAX_HOOK_CHAIN_LENGTH, MAX_HOOK_CHAIN_NAME_LENGTH } from '@server/realtime/runContext';

declare module 'express-serve-static-core' {
  interface Request {
    /**
     * Which credential class authenticated the request. The /execute handler
     * denies `act_as_agent_id` for 'child-dispatch'.
     */
    toolExecuteAuthScope?: 'panel' | 'child-dispatch';
    /**
     * The agent a verified child-dispatch token is bound to, taken from the
     * token, never from the request. Empty means bound to no agent, which the
     * /execute handler rejects (every spawn site binds one, ghost when no agent
     * is running). The /execute handler acts as this agent, never as the
     * body's `agent_id`. Set only for 'child-dispatch'.
     */
    childDispatchAgentId?: string;
    hookOriginName?: string;
    /**
     * Hook chain depth signed into a verified child-dispatch token (0 when
     * absent). Requests authenticated any other way are a person's action (0).
     */
    childDispatchChainDepth?: number;
    /**
     * Hook chain signed into a verified child-dispatch token: the names of the
     * hooks whose runs led to this call, oldest first (empty when absent).
     * Requests authenticated any other way start no chain.
     */
    childDispatchChain?: readonly string[];
    /**
     * Signed into a verified child-dispatch token when the hook run may not
     * auto-approve (an agent started or caused it). Absent otherwise.
     */
    childDispatchUnattendedCap?: boolean;
    /**
     * Signed into a verified child-dispatch token when the hook runs as the
     * agent a person set for it (`hook_registrations.run_as_agent_id`), not
     * as the event's agent or ghost. Absent otherwise.
     */
    childDispatchRunAs?: boolean;
    /**
     * Signed into a verified child-dispatch token for a hook run that has a
     * thread (its event's): the thread whose per-agent "ask first" settings
     * apply to the hook's calls. Absent otherwise.
     */
    childDispatchThreadId?: string;
  }
}

/**
 * The panel token, held only in memory and never persisted. The packaged app's
 * shell mints it (SNAGLET_PANEL_TOKEN) and injects it into the webview's init
 * script. Without the shell it is self-generated, and WebSocketService pushes
 * it only to clients whose Origin is one of this server's UI origins (a page
 * driven to load the dev UI still passes). `snaglet run` presents the sidecar token
 * instead. Never given to a spawned child (see buildSafeEnv.ts). An agent with
 * an unrestricted shell as the same OS user can still recover it; a token
 * check cannot guard against that.
 */
const PANEL_TOKEN: string =
  process.env.SNAGLET_PANEL_TOKEN?.trim() || randomBytes(32).toString('hex');

/**
 * Signs child-dispatch tokens. Self-generated, memory-only and never given to
 * a child: tokens only ever verify against the process that minted them.
 */
const CHILD_DISPATCH_SECRET: Buffer = randomBytes(32);

/** The panel token, for the dev-mode WebSocket push and routes that compare it directly. */
export function getPanelToken(): string {
  return PANEL_TOKEN;
}

/**
 * Mint a child-dispatch token that authorizes acting as `agentId` and nothing
 * else. Call it fresh at every spawn and never reuse a token across agents or
 * share one value between children. With no `agentId` the token is bound to no
 * agent, which /execute rejects rather than treating as a wildcard.
 *
 * Format: `base64url(payload).base64url(HMAC-SHA256(payload))`. Signed, not
 * encrypted: the payload is not secret, only tamper-proof, and no server-side
 * table of issued tokens is needed.
 */
export function mintChildDispatchToken(
  agentId?: string,
  hookName?: string,
  chainDepth?: number,
  hookChain?: readonly string[],
  /** The run may not auto-approve (an agent started or caused it). */
  unattendedCap?: boolean,
  /** The hook runs as the agent a person set for it (run as), not the event's. */
  runAs?: boolean,
  /** The hook run's thread, whose "ask first" settings apply to its calls. */
  threadId?: string
): string {
  // Chain depth and the hook chain are signed into the token, so a child can't
  // reset its depth (dodging the loop stops) or clear its chain to rerun a hook
  // that already ran. With no extra fields the payload is the bare agent id.
  const depth =
    typeof chainDepth === 'number' && Number.isInteger(chainDepth) && chainDepth > 0
      ? chainDepth
      : 0;
  const chain = hookChain && hookChain.length > 0 ? [...hookChain] : undefined;
  const payload =
    hookName || depth > 0 || chain || unattendedCap || runAs || threadId
      ? JSON.stringify({
          agentId: agentId ?? '',
          ...(hookName ? { hookName } : {}),
          ...(depth > 0 ? { chainDepth: depth } : {}),
          ...(chain ? { hookChain: chain } : {}),
          ...(unattendedCap ? { unattendedCap: true } : {}),
          ...(runAs ? { runAs: true } : {}),
          ...(threadId ? { threadId } : {}),
        })
      : (agentId ?? '');
  const encodedPayload = Buffer.from(payload, 'utf8').toString('base64url');
  const mac = createHmac('sha256', CHILD_DISPATCH_SECRET)
    .update(payload, 'utf8')
    .digest('base64url');
  return `${encodedPayload}.${mac}`;
}

/**
 * Verify a child-dispatch token (constant-time HMAC compare) and return what it
 * is bound to, or `null` for anything malformed, forged or signed by another
 * boot (treated as no credential). The returned `agentId` (`''` = no agent) is
 * the only source of truth for who the request acts as: the body's `agent_id`
 * is written by the very code this credential exists to distrust.
 */
export function verifyChildDispatchToken(token: string): {
  agentId: string;
  hookName?: string;
  chainDepth?: number;
  hookChain?: string[];
  unattendedCap?: true;
  runAs?: true;
  threadId?: string;
} | null {
  const dotIndex = token.indexOf('.');
  if (dotIndex < 0) return null;
  const encodedPayload = token.slice(0, dotIndex);
  const presentedMac = token.slice(dotIndex + 1);

  let payload: string;
  try {
    payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const expectedMac = createHmac('sha256', CHILD_DISPATCH_SECRET)
    .update(payload, 'utf8')
    .digest('base64url');
  if (!tokensMatch(presentedMac, expectedMac)) return null;
  if (payload.startsWith('{')) {
    try {
      const parsed = JSON.parse(payload) as {
        agentId?: unknown;
        hookName?: unknown;
        chainDepth?: unknown;
        hookChain?: unknown;
        unattendedCap?: unknown;
        runAs?: unknown;
        threadId?: unknown;
      };
      if (typeof parsed.agentId !== 'string') return null;
      if (parsed.hookName !== undefined && typeof parsed.hookName !== 'string') return null;
      if (
        parsed.chainDepth !== undefined &&
        !(
          typeof parsed.chainDepth === 'number' &&
          Number.isInteger(parsed.chainDepth) &&
          parsed.chainDepth > 0
        )
      ) {
        return null;
      }
      if (parsed.hookChain !== undefined && !isValidHookChain(parsed.hookChain)) return null;
      if (parsed.unattendedCap !== undefined && parsed.unattendedCap !== true) return null;
      if (parsed.runAs !== undefined && parsed.runAs !== true) return null;
      if (parsed.threadId !== undefined && typeof parsed.threadId !== 'string') return null;
      if (
        parsed.hookName === undefined &&
        parsed.chainDepth === undefined &&
        parsed.hookChain === undefined &&
        parsed.unattendedCap === undefined &&
        parsed.runAs === undefined &&
        parsed.threadId === undefined
      ) {
        return null;
      }
      return {
        agentId: parsed.agentId,
        ...(typeof parsed.hookName === 'string' ? { hookName: parsed.hookName } : {}),
        ...(typeof parsed.chainDepth === 'number' ? { chainDepth: parsed.chainDepth } : {}),
        ...(parsed.hookChain !== undefined ? { hookChain: parsed.hookChain } : {}),
        ...(parsed.unattendedCap === true ? { unattendedCap: true as const } : {}),
        ...(parsed.runAs === true ? { runAs: true as const } : {}),
        ...(typeof parsed.threadId === 'string' ? { threadId: parsed.threadId } : {}),
      };
    } catch {
      return null;
    }
  }
  return { agentId: payload };
}

/**
 * A signed chain must still be well formed: 1 to MAX_HOOK_CHAIN_LENGTH
 * non-empty names of at most MAX_HOOK_CHAIN_NAME_LENGTH characters. Anything
 * else rejects the whole token, as a bad depth does.
 */
function isValidHookChain(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_HOOK_CHAIN_LENGTH &&
    value.every(
      (name) =>
        typeof name === 'string' && name.length > 0 && name.length <= MAX_HOOK_CHAIN_NAME_LENGTH
    )
  );
}

/** Constant-time compare: `===` leaks how many leading bytes a guess got right. */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Full-authority gate. Accepts `X-Snaglet-Panel-Token`, or `X-Snaglet-Sidecar-Token`
 * matching SNAGLET_AUTH_TOKEN when one is set (the `snaglet run` CLI path). Missing or
 * wrong is a 403, never a 404: ToolView reads 404 as "route not mounted".
 * Mount this, not `toolDispatchAuthMiddleware`, on any path that must never
 * accept a child-dispatch token, e.g. /execute/test.
 */
export function panelAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const presentedPanelToken = req.get('x-snaglet-panel-token');
  if (presentedPanelToken && tokensMatch(presentedPanelToken, PANEL_TOKEN)) {
    req.toolExecuteAuthScope = 'panel';
    next();
    return;
  }

  const sidecarToken = process.env.SNAGLET_AUTH_TOKEN;
  const presentedSidecarToken = req.get('x-snaglet-sidecar-token');
  if (sidecarToken && presentedSidecarToken && tokensMatch(presentedSidecarToken, sidecarToken)) {
    req.toolExecuteAuthScope = 'panel';
    next();
    return;
  }

  next(
    new AuthError('Unauthorized: missing or invalid panel execution token', ErrorCode.FORBIDDEN)
  );
}

/**
 * Gate for POST /api/tools/execute (and /execute/log) that also accepts a
 * child-dispatch token from a server-spawned tool, hook or /execute/test
 * runner. That token grants no `act_as_agent_id` and no /execute/test, and acts
 * only as the agent it is bound to: this sets `req.childDispatchAgentId` from
 * the verified token so the handler can require a non-empty binding and reject
 * a body `agent_id` naming another agent. Never mount this on /execute/test.
 */
export function toolDispatchAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const presentedDispatchToken = req.get('x-snaglet-child-dispatch-token');
  if (presentedDispatchToken) {
    const verified = verifyChildDispatchToken(presentedDispatchToken);
    if (verified) {
      req.toolExecuteAuthScope = 'child-dispatch';
      req.childDispatchAgentId = verified.agentId;
      if (verified.hookName) req.hookOriginName = verified.hookName;
      req.childDispatchChainDepth = verified.chainDepth ?? 0;
      req.childDispatchChain = verified.hookChain ?? [];
      if (verified.unattendedCap) req.childDispatchUnattendedCap = true;
      if (verified.runAs) req.childDispatchRunAs = true;
      if (verified.threadId) req.childDispatchThreadId = verified.threadId;
      next();
      return;
    }
  }
  panelAuthMiddleware(req, res, next);
}
