import { readFile, unlink } from 'fs/promises';
import { execFile } from 'child_process';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import { generateId, getErrorMessage, safeJsonParse } from '@snaglet/shared/utils';
import { Agents } from '@snaglet/db/tables/agents';
import { Images } from '@snaglet/db/tables/images';
import {
  AGENT_CURSOR_EVENT,
  AGENT_CURSOR_FLOWER_EVENT,
  FLOWER_HANDOFF_MS,
  resolveAgentCursor,
} from '@snaglet/shared/constants/agentCursor';
import type {
  AgentCursorEvent,
  AgentCursorState,
  AvatarEmote,
} from '@snaglet/shared/constants/agentCursor';
import type { EmotionId } from '@snaglet/shared/cursor';
import type { ToolHandler, ToolHandlerRichResult } from '@server/services/ToolService/types';
import { sniffImageMime } from '@server/services/ToolService/lib/sniffImageMime';
import { resolveAgentImageContainer } from '@server/services/ToolService/lib/resolveAgentImageContainer';
import { emitTreeNodeCreated, snapshotFromImage } from '@server/realtime/surfaces/tree';
import { cursorClaimService } from '@server/services/CursorClaimService';
import { approvalRequired, cursorApprovalService } from '@server/services/CursorApprovalService';
import { agentCursorSessions } from '@server/services/agentCursorSessions';
import { isSystemOverlayActive } from '@server/services/systemCursorOverlay';
import { systemCursorOverlayLauncher } from '@server/services/systemCursorOverlayLauncher';
import { wsService } from '@server/services/WebSocketService';
import { logger } from '@server/config/logger';
import { DANGER_NAME } from '@server/services/BrowserController/policy';
import { MOUSE_JXA } from './mouseScript';
import { INPUT_JXA } from './inputScript';
import { AX_JXA } from './axScript';
import { POINTER_JXA } from './pointerScript';

const execFileAsync = promisify(execFile);

interface CursorAgentRow {
  id: string;
  name: string;
  cursor_flower: string | null;
  cursor_color: string | null;
}

const lastPos = new Map<string, { x: number; y: number }>();
/** Where this tool last SET the real pointer, per agent (for user-takeover detection). */
const lastSet = new Map<string, { x: number; y: number; at: number }>();
export const TAKEOVER_MAX_AGE_MS = 20_000;

/**
 * Where the agent's flower may be redrawn outside a computer op (emotion, error): only while it
 * still holds the cursor claim. A released, revoked (Esc) or lapsed claim forgets the position, so
 * a later think/ask/error can never resurrect the overlay after the agent let go.
 */
function onScreenPos(agentId: string): { x: number; y: number } | undefined {
  if (cursorClaimService.holderAgentId() !== agentId) {
    lastPos.delete(agentId);
    return undefined;
  }
  return lastPos.get(agentId);
}

/** Drop an agent's on-screen position (claim released or revoked). */
export function forgetCursorPosition(agentId: string): void {
  lastPos.delete(agentId);
  lastSet.delete(agentId);
}
export const TAKEOVER_DISTANCE_PX = 12;

export function emitCursor(
  agent: {
    id: string;
    name: string;
    cursor_flower?: string | null;
    cursor_color?: string | null;
  },
  state: AgentCursorState,
  pos: { x: number; y: number },
  label?: string,
  emotion?: EmotionId,
  animation?: AvatarEmote,
  glideMs?: number,
  emotionUpdate?: AgentCursorEvent['emotionUpdate']
): void {
  try {
    // Keep the full-screen overlay up while the holder is visibly working (it may have
    // been quit from the menu bar or crashed since the claim). Rate-limited inside.
    if (state !== 'hidden' && cursorClaimService.holderAgentId() === agent.id)
      systemCursorOverlayLauncher.ensure();
    const { flower, color } = resolveAgentCursor(
      agent.id,
      agent.cursor_flower ?? null,
      agent.cursor_color ?? null
    );
    const payload: AgentCursorEvent = {
      agentId: agent.id,
      name: agent.name,
      flower,
      color,
      state,
      x: pos.x,
      y: pos.y,
      label,
      holderAgentId: cursorClaimService.holderAgentId(),
      ...(isSystemOverlayActive() ? { systemOverlay: true } : {}),
      ...(emotion ? { emotion } : {}),
      ...(emotionUpdate ? { emotionUpdate } : {}),
      ...(animation ? { animation, animationId: generateId() } : {}),
      ...(glideMs !== undefined ? { glideMs } : {}),
    };
    Object.assign(payload, agentCursorSessions.onEmit(payload));
    wsService.broadcast({ type: AGENT_CURSOR_EVENT, payload });
  } catch (err) {
    logger.error('[computer] cursor emit failed', { error: err });
  }
}

/**
 * The person hid (×, or dragged off the edge) or parked an agent's flower, any agent's: record
 * it for the session and tell every overlay. False when that session is no longer up.
 * Moving the mouse to a flower is not taking the cursor back, so from then on the takeover
 * check of the agent at work measures from where the person left the pointer (`pointer`,
 * screen points). Only a pointer that was on that flower counts; a keyboard × sends none.
 */
export function applyFlowerChoice(
  agentId: string,
  choice: { dismiss: true } | { park: { x: number; y: number } },
  from: { session: string; pointer?: { x: number; y: number } }
): boolean {
  const pointer =
    from.pointer &&
    agentCursorSessions.reachedFlower(
      agentId,
      from.session,
      from.pointer,
      'park' in choice ? choice.park : undefined
    )
      ? from.pointer
      : undefined;
  const update =
    'dismiss' in choice
      ? agentCursorSessions.dismiss(agentId, from.session)
      : agentCursorSessions.park(agentId, from.session, choice.park);
  if (!update) return false;
  const holder = cursorClaimService.holderAgentId();
  if (pointer && holder && lastSet.has(holder)) {
    lastSet.set(holder, { x: pointer.x, y: pointer.y, at: Date.now() });
  }
  wsService.broadcast({ type: AGENT_CURSOR_FLOWER_EVENT, payload: update });
  return true;
}

type JxaResult = {
  ok?: boolean;
  error?: string;
  [k: string]: unknown;
};

/** Every shell/JXA call goes through here so tests can replace it. */
export const deps = {
  runJxa: async (script: string, args: string[]): Promise<JxaResult> => {
    try {
      const { stdout } = await execFileAsync(
        'osascript',
        ['-l', 'JavaScript', '-e', script, ...args],
        {
          timeout: 15000,
          maxBuffer: 4 * 1024 * 1024,
        }
      );
      return JSON.parse(stdout.trim() || '{}') as JxaResult;
    } catch (err) {
      return { ok: false, error: `osascript_failed: ${getErrorMessage(err)}` };
    }
  },
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

const runMouse = (action: 'move' | 'click', x: number, y: number, button: string) =>
  deps.runJxa(MOUSE_JXA, [action, String(x), String(y), button]);
const runInput = (action: string, args: Record<string, unknown>) =>
  deps.runJxa(INPUT_JXA, [action, JSON.stringify(args)]);
const runPointer = () => deps.runJxa(POINTER_JXA, []);
const runAx = (action: string, args: Record<string, unknown> = {}) =>
  deps.runJxa(AX_JXA, [action, JSON.stringify(args)]);

/** How often an op rechecks a flower the person is dragging. */
const FLOWER_GRAB_POLL_MS = 100;

/**
 * Wait while the person holds any agent's flower, so input never moves the pointer out from
 * under their drag. Bounded by the grab's own expiry and ends if this agent's claim goes.
 * True when it had to wait.
 */
async function waitWhileFlowerHeld(agentId: string): Promise<boolean> {
  let waited = false;
  while (agentCursorSessions.anyGrabbed() && cursorClaimService.holderAgentId() === agentId) {
    waited = true;
    await deps.sleep(FLOWER_GRAB_POLL_MS);
  }
  return waited;
}

/** Longest an op waits for a person whose pointer rests on a flower. */
const FLOWER_REACH_MAX_MS = 3000;

/**
 * Whether the person took the pointer back since the agent last set it. A pointer resting on
 * a flower is someone reaching for its × or about to drag it: wait (bounded) for them to hide
 * or park it, or to leave the pointer where the agent had it, before calling it a takeover.
 */
async function pointerTakenOver(agentId: string): Promise<boolean> {
  const deadline = Date.now() + FLOWER_REACH_MAX_MS;
  for (;;) {
    const prev = lastSet.get(agentId);
    if (!prev) return false;
    const cur = await runPointer();
    if (!cur.ok || typeof cur.x !== 'number' || typeof cur.y !== 'number') return false;
    if (Math.hypot(cur.x - prev.x, cur.y - prev.y) <= TAKEOVER_DISTANCE_PX) return false;
    const reaching = agentCursorSessions.pointerOnFlower({ x: cur.x, y: cur.y });
    if (!reaching || Date.now() >= deadline) return true;
    await deps.sleep(FLOWER_GRAB_POLL_MS);
    await waitWhileFlowerHeld(agentId);
    if (cursorClaimService.holderAgentId() !== agentId) return false;
  }
}

export const MAX_WAIT_MS = 10_000;
export const MAX_LOOK_ELEMENTS = 150;
// One danger list for desktop and browser tools.
export const DANGER_LABEL = DANGER_NAME;
// Keys / text endings that commit the focused control.
const COMMIT_KEY = /(^|\+)(enter|return)$/i;
const TRAILING_NEWLINE = /[\r\n]\s*$/;
export const SECRET_LABEL = /password|passcode|card number|cvv|secret|token|api key/i;

interface LookEl {
  id: string;
  path: number[];
  role: string;
  subrole: string;
  label: string;
  value: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
const lastLook = new Map<string, LookEl[]>();

const isSecure = (e: { role?: string; subrole?: string; label?: string }) =>
  e.role === 'AXSecureTextField' ||
  e.subrole === 'AXSecureTextField' ||
  SECRET_LABEL.test(e.label ?? '');

const permMessage =
  'Accessibility permission is missing: grant it to the Snaglet server process in System Settings > Privacy & Security > Accessibility.';
const fail = (r: JxaResult) =>
  r.error === 'accessibility_permission_missing' ? permMessage : (r.error ?? 'input failed');

const center = (e: LookEl) => ({ x: Math.round(e.x + e.w / 2), y: Math.round(e.y + e.h / 2) });
const pointIn = (e: LookEl, p: { x: number; y: number }) =>
  e.w > 0 && e.h > 0 && p.x >= e.x && p.x <= e.x + e.w && p.y >= e.y && p.y <= e.y + e.h;

type Spec = unknown;
/** Resolve an element id string, {x,y} object, or fallback x/y to a point. */
function resolveSpec(
  agentId: string,
  spec: Spec,
  fx?: unknown,
  fy?: unknown
): { point: { x: number; y: number }; el?: LookEl } | { error: string } {
  if (typeof spec === 'string' && spec) {
    const el = lastLook.get(agentId)?.find((e) => e.id === spec);
    if (!el)
      return { error: `unknown element "${spec}": call op:look first and use a returned id` };
    return { point: center(el), el };
  }
  const o = (spec && typeof spec === 'object' ? spec : { x: fx, y: fy }) as {
    x?: unknown;
    y?: unknown;
  };
  const x = Number(o.x);
  const y = Number(o.y);
  if (o.x == null || o.y == null || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    return { error: 'give a target element id or non-negative x and y' };
  }
  const el = lastLook
    .get(agentId)
    ?.filter((e) => pointIn(e, { x, y }))
    .sort((a, b) => a.w * a.h - b.w * b.h)[0];
  return { point: { x, y }, el };
}

async function loadAgentRow(agentId: string): Promise<CursorAgentRow> {
  const agent = await Agents.findById(agentId).catch(() => null);
  return {
    id: agentId,
    name: agent?.name ?? 'An agent',
    // Agent rows are camelCase; the snake_case names are what the tests feed.
    cursor_flower:
      (agent as { cursorFlower?: string | null; cursor_flower?: string | null } | null)
        ?.cursorFlower ??
      (agent as { cursor_flower?: string | null } | null)?.cursor_flower ??
      null,
    cursor_color:
      (agent as { cursorColor?: string | null; cursor_color?: string | null } | null)
        ?.cursorColor ??
      (agent as { cursor_color?: string | null } | null)?.cursor_color ??
      null,
  };
}

const ERROR_TEXT_MAX = 160;

/**
 * If a final reply is a genuine failure (ok:false with an `error` string), show
 * the agent's cursor looking stumped with the error as its label. Busy,
 * needsApproval, denied, timedOut and interrupted replies are flow control, not
 * errors; simulated and ok:true replies never qualify. Never throws.
 */
function emitErrorCursor(agentId: string, reply: unknown, agentRow: CursorAgentRow): void {
  try {
    if (typeof reply !== 'string') return;
    const r = safeJsonParse<Record<string, unknown>>(reply);
    if (!r || r.ok !== false || typeof r.error !== 'string' || !r.error.trim()) return;
    if (r.busy || r.needsApproval || r.denied || r.timedOut || r.interrupted) return;
    const text = r.error.trim();
    const label = text.length > ERROR_TEXT_MAX ? `${text.slice(0, ERROR_TEXT_MAX - 1)}…` : text;
    // No known position yet means the agent has not appeared anywhere: show nothing
    // rather than a stumped flower in the screen corner.
    const at = onScreenPos(agentId);
    if (!at) return;
    emitCursor(agentRow, 'idle', at, label, 'stumped');
  } catch {
    // best-effort visual only
  }
}

const EMOTION_ROW_TTL_MS = 30_000;
const emotionRows = new Map<string, { at: number; row: Promise<CursorAgentRow> }>();

/**
 * Draws an emotion on the agent's overlay cursor at its last known position: an `idle` event
 * carrying `emotion` (and an optional label), the same shape emitErrorCursor builds. 'neutral'
 * clears a held emotion at once. No known position means the agent is not on screen: emits
 * nothing. The agent row is cached briefly so repeated calls cost no DB access. Never throws.
 */
export async function emitEmotionCursor(
  agentId: string,
  emotion: EmotionId,
  label?: string,
  emotionUpdate?: AgentCursorEvent['emotionUpdate']
): Promise<void> {
  try {
    if (!onScreenPos(agentId)) return;
    const now = Date.now();
    let hit = emotionRows.get(agentId);
    if (!hit || now - hit.at > EMOTION_ROW_TTL_MS) {
      hit = { at: now, row: loadAgentRow(agentId) };
      emotionRows.set(agentId, hit);
    }
    const row = await hit.row;
    const at = onScreenPos(agentId);
    if (!at) return;
    emitCursor(row, 'idle', at, label, emotion, undefined, undefined, emotionUpdate);
  } catch {
    // best-effort visual only
  }
}

const INPUT_OPS = new Set(['move', 'click', 'drag', 'scroll', 'type', 'key']);

const computerTool: ToolHandler = async (
  input,
  _settings,
  context
): Promise<string | ToolHandlerRichResult> => {
  const agentId = context?.agentId;
  if (!agentId) throw new Error('computer: requires an agent context');
  const op = String(input.op ?? '');
  const reason = input.reason ? String(input.reason) : undefined;
  const agentRow = await loadAgentRow(agentId);
  const pos = lastPos.get(agentId) ?? { x: 0, y: 0 };
  const json = (v: unknown) => JSON.stringify(v);
  const approved = input.approved === true;
  const realInput = process.env.SNAGLET_COMPUTER_ALLOW_INPUT === '1';
  const simulated = (extra: Record<string, unknown> = {}) =>
    json({
      ok: true,
      simulated: true,
      note: 'Real input disabled (SNAGLET_COMPUTER_ALLOW_INPUT!=1)',
      ...extra,
    });

  if (process.platform !== 'darwin') {
    return json({ ok: false, error: 'computer works on macOS only' });
  }

  // One-line action log. Never includes typed text, only its length.
  logger.info('[computer] action', {
    op,
    agentId,
    reason,
    ...(op === 'type' ? { textLength: String(input.text ?? '').length } : {}),
  });

  const needsApproval = (label: string) =>
    json({
      ok: false,
      needsApproval: true,
      message: `"${label}" looks like a consequential control. Use the ask tool to get the user's answer first; only after they say yes, repeat this call with approved:true. Do not act until then.`,
    });

  const allowedApps = (process.env.SNAGLET_COMPUTER_ALLOWED_APPS ?? '')
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  const checkAllowlist = async (): Promise<string | null> => {
    if (allowedApps.length === 0) return null;
    const f = await runAx('front');
    if (!f.ok) return json({ ok: false, error: fail(f) });
    if (!allowedApps.includes(String(f.app ?? '').toLowerCase())) {
      return json({
        ok: false,
        error: `The frontmost app "${String(f.app)}" is not in the allowed list (SNAGLET_COMPUTER_ALLOWED_APPS).`,
      });
    }
    return null;
  };

  const releaseClaim = (): boolean => {
    const released = cursorClaimService.release(agentId);
    forgetCursorPosition(agentId);
    if (released) {
      // Keep the avatar visible as idle rather than deleting it from the overlay.
      // Overlays prune it after CURSOR_SESSION_IDLE_MS (2 min) without events.
      // If pos is still the {0,0} fallback (lastPos was never set) there is nowhere
      // sensible to place the flower, so emit nothing.
      if (pos.x !== 0 || pos.y !== 0) {
        emitCursor(agentRow, 'idle', pos);
      }
    }
    return released;
  };

  // Reading the screen or acting on an element is as sensitive as clicking: it
  // needs the claim, and the claim needs the user's approval (or a session grant).
  const needClaim = (): string | null => {
    const busyNow = cursorClaimService.busyFor(agentId);
    if (busyNow) return json(busyNow);
    if (cursorClaimService.holderAgentId() !== agentId) {
      return json({
        ok: false,
        error: `You do not hold the cursor. Call op:claim first (the user is asked to allow it); op:${op} reads or acts on the real screen.`,
      });
    }
    return null;
  };

  switch (op) {
    case 'claim': {
      const busyNow = cursorClaimService.busyFor(agentId);
      if (busyNow) return json(busyNow);
      if (approvalRequired() && !cursorApprovalService.hasSessionGrant(agentId)) {
        const { flower, color } = resolveAgentCursor(
          agentId,
          agentRow.cursor_flower,
          agentRow.cursor_color
        );
        const outcome = await cursorApprovalService.requestApproval({
          agentId,
          name: agentRow.name,
          reason,
          flower,
          color,
        });
        if (outcome === 'deny') {
          return json({
            ok: false,
            denied: true,
            message:
              'The user did not allow cursor control. Do not ask again unless they invite you to.',
          });
        }
        if (outcome === 'timeout') {
          return json({
            ok: false,
            timedOut: true,
            message: 'No answer from the user. Try again later or ask them in chat.',
          });
        }
      }
      if (cursorClaimService.holderAgentId() !== agentId) lastSet.delete(agentId);
      const r = cursorClaimService.claim(agentId, agentRow.name, reason);
      if (r.ok) {
        // Draw the flower and its narration over the whole screen, not just inside Snaglet.
        systemCursorOverlayLauncher.ensure();
        // Show the avatar where the user's real pointer is right now, not in the
        // corner, so it appears in the right place the moment the claim is granted.
        let at = pos;
        if (realInput) {
          const cur = await runPointer().catch(() => null);
          if (cur && cur.ok && Number.isFinite(Number(cur.x)) && Number.isFinite(Number(cur.y))) {
            at = { x: Number(cur.x), y: Number(cur.y) };
            lastPos.set(agentId, at);
          }
        }
        emitCursor(agentRow, 'idle', at, reason);
      }
      return json(r);
    }
    case 'release': {
      const released = releaseClaim();
      return json({ ok: true, released });
    }
    case 'status': {
      const h = cursorClaimService.holderInfo();
      return json({
        ok: true,
        free: !h,
        holder: h ? (h.agentId === agentId ? 'you' : h.name) : null,
        expiresInSec: h?.expiresInSec ?? null,
        inputEnabled: realInput,
        approvalRequired: approvalRequired(),
        sessionGrants: cursorApprovalService.sessionGrants(),
        allowedApps,
      });
    }
    case 'point': {
      // Display-only: draws this agent's flower at a screen spot with a label so several
      // agents can flag UI at once. Never moves the real pointer, reads the screen or sends
      // input, so it needs no claim; the overlay prunes it after CURSOR_IDLE_TIMEOUT_MS.
      const x = Number(input.x);
      const y = Number(input.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return json({ ok: false, error: 'point needs numeric x and y (screen points).' });
      }
      const at = { x, y };
      lastPos.set(agentId, at);
      systemCursorOverlayLauncher.ensure();
      // glide_ms: linear glide of that length, so a script sending evenly timed waypoints
      // gets one continuous motion instead of a stop-start ease at every point.
      const g = Number(input.glide_ms);
      const glide = Number.isFinite(g) ? Math.min(10_000, Math.max(0, Math.round(g))) : undefined;
      emitCursor(agentRow, 'idle', at, reason, undefined, undefined, glide);
      return json({ ok: true, pointed: at, holder: cursorClaimService.holderInfo()?.name ?? null });
    }
    case 'hide': {
      // Display-only: removes this agent's flower from the overlay now (point flowers are
      // otherwise only pruned after CURSOR_IDLE_TIMEOUT_MS). Never touches the claim.
      const at = lastPos.get(agentId) ?? pos;
      lastPos.delete(agentId);
      emitCursor(agentRow, 'hidden', at);
      return json({ ok: true, hidden: true });
    }
    case 'wait': {
      const requested = Number(input.ms);
      const ms = Math.min(MAX_WAIT_MS, Math.max(0, Number.isFinite(requested) ? requested : 1000));
      cursorClaimService.renew(agentId);
      if (cursorClaimService.holderAgentId() === agentId)
        emitCursor(agentRow, 'waiting', pos, reason);
      await deps.sleep(ms);
      return json({ ok: true, waitedMs: ms, capped: requested > MAX_WAIT_MS });
    }
    case 'look': {
      const unclaimed = needClaim();
      if (unclaimed) return unclaimed;
      const denied = await checkAllowlist();
      if (denied) return denied;
      const r = await runAx('look', { max: MAX_LOOK_ELEMENTS, maxDepth: 8 });
      if (!r.ok) return json({ ok: false, error: `look failed: ${fail(r)}` });
      const raw = (Array.isArray(r.elements) ? r.elements : []) as Omit<LookEl, 'id'>[];
      const capped = raw.slice(0, MAX_LOOK_ELEMENTS);
      const elements: LookEl[] = capped.map((e, i) => ({ ...e, id: `e${i + 1}` }));
      lastLook.set(agentId, elements);
      cursorClaimService.renew(agentId);
      // Visible only: the flower glides to the middle of what it is reading. The
      // real pointer does not move.
      const sized = elements.filter((e) => e.w > 0 && e.h > 0);
      if (sized.length > 0) {
        const left = Math.min(...sized.map((e) => e.x));
        const top = Math.min(...sized.map((e) => e.y));
        const right = Math.max(...sized.map((e) => e.x + e.w));
        const bottom = Math.max(...sized.map((e) => e.y + e.h));
        const at = { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
        lastPos.set(agentId, at);
        emitCursor(agentRow, 'move', at, reason ?? `looking at ${String(r.app ?? 'the screen')}`);
      }
      return json({
        ok: true,
        frontmostApp: r.app,
        windowTitle: r.title ?? '',
        truncated: raw.length > MAX_LOOK_ELEMENTS || r.truncated === true,
        elements: elements.map((e) => ({
          id: e.id,
          role: e.role,
          label: e.label,
          value: isSecure(e) ? '' : e.value,
          x: e.x,
          y: e.y,
          w: e.w,
          h: e.h,
        })),
      });
    }
    case 'act': {
      const unclaimed = needClaim();
      if (unclaimed) return unclaimed;
      const denied = await checkAllowlist();
      if (denied) return denied;
      const action = String(input.action ?? '');
      if (!['press', 'set_value', 'select'].includes(action)) {
        return json({ ok: false, error: 'action must be press, set_value or select' });
      }
      const el =
        typeof input.target === 'string'
          ? lastLook.get(agentId)?.find((e) => e.id === input.target)
          : undefined;
      if (!el)
        return json({ ok: false, error: 'target must be an element id from the last op:look' });
      if (action === 'set_value' && isSecure(el)) {
        return json({ ok: false, error: 'Refusing to set a value on a password/secret field.' });
      }
      if (action !== 'select' && DANGER_LABEL.test(el.label) && !approved)
        return needsApproval(el.label);
      cursorClaimService.renew(agentId);
      emitCursor(agentRow, 'click', center(el), reason);
      if (!realInput) return simulated();
      const r = await runAx('act', { path: el.path, action, value: String(input.value ?? '') });
      return r.ok ? json({ ok: true, simulated: false }) : json({ ok: false, error: fail(r) });
    }
    case 'screenshot': {
      const unclaimed = needClaim();
      if (unclaimed) return unclaimed;
      // Visible only: show the flower where it last was while it takes the shot.
      emitCursor(
        agentRow,
        'idle',
        lastPos.get(agentId) ?? { x: 0, y: 0 },
        reason ?? 'taking a screenshot'
      );
      const tempPath = path.join(tmpdir(), `snaglet-computer-${generateId('tmp')}.png`);
      let buf: Buffer | null = null;
      try {
        await execFileAsync('screencapture', ['-x', tempPath], { timeout: 15000 });
        buf = await readFile(tempPath);
      } catch {
        buf = null;
      } finally {
        // eslint-disable-next-line no-restricted-syntax -- best-effort temp cleanup
        await unlink(tempPath).catch(() => {});
      }
      if (!buf || buf.byteLength === 0) {
        return json({
          ok: false,
          error: 'screenshot failed (Screen Recording permission missing?)',
        });
      }
      const imageId = generateId('image');
      const created = await Images.createImage({
        id: imageId,
        name: `screen-${imageId.slice(0, 8)}.png`,
        containerId: await resolveAgentImageContainer(context?.threadId),
        mimeType: sniffImageMime(buf) ?? 'image/png',
        data: buf,
        sizeBytes: buf.byteLength,
        tags: ['tool-capture'],
      });
      emitTreeNodeCreated(snapshotFromImage(created));
      cursorClaimService.renew(agentId);
      return {
        output: `captured, image id ${imageId}`,
        rawContent: { inlineImageIds: [imageId], note: `screen capture saved as ${imageId}` },
      };
    }
    default:
      if (!INPUT_OPS.has(op)) return json({ ok: false, error: `unknown op "${op}"` });
  }

  // Cursor-lane input ops: need the claim.
  const busy = cursorClaimService.busyFor(agentId);
  if (busy) return json(busy);
  if (cursorClaimService.holderAgentId() !== agentId) {
    return json({ ok: false, error: 'You do not hold the cursor. Call op:claim first.' });
  }
  if (realInput) await waitWhileFlowerHeld(agentId);
  // User takeover: if the pointer is not where we last left it, the user moved it.
  const prev = lastSet.get(agentId);
  if (realInput && prev && Date.now() - prev.at < TAKEOVER_MAX_AGE_MS) {
    if (await pointerTakenOver(agentId)) {
      releaseClaim();
      return json({
        ok: false,
        interrupted: true,
        message:
          'The user moved the mouse, so cursor control was released. Ask before taking it again.',
      });
    }
  } else if (prev) {
    lastSet.delete(agentId);
  }

  const denied = await checkAllowlist();
  if (denied) return denied;

  const claimEnded = () =>
    json({
      ok: false,
      error:
        'Your cursor claim ended (the user stopped the agent cursors or the lease expired), so nothing was sent. Call op:claim again if you still need it, and ask first if the user stopped you.',
    });

  /**
   * Where the input acts: mouse input at these screen points (null: at the pointer, wherever
   * it is now), or keystrokes, which go to the focused app and which a flower never takes.
   */
  type InputAt = { points: Array<{ x: number; y: number }> | null } | 'keys';

  const finish = async (
    state: AgentCursorState,
    at: { x: number; y: number },
    run: () => Promise<JxaResult>,
    movesPointer: boolean,
    input: InputAt
  ) => {
    // The awaits above (pointer read, allowlist) can outlast a /stop or lease
    // expiry. Never post input once the claim is gone.
    if (!cursorClaimService.renew(agentId)) return claimEnded();
    lastPos.set(agentId, at);
    // After a hold, the panel the person was dragging can sit at its old spot (unknown here)
    // until the overlay's next poll, so the next pass always waits.
    let afterHold = false;
    for (;;) {
      // Decided before the emit below, which restarts every flower's settle time.
      const handoff =
        realInput &&
        input !== 'keys' &&
        (afterHold || agentCursorSessions.needsHandoff(input.points));
      emitCursor(agentRow, state, at, reason);
      if (!realInput) return simulated();
      // A still flower takes the mouse and could sit where this input lands. The event just
      // sent makes every flower in every overlay click-through; let it arrive before the
      // pointer acts.
      if (handoff) await deps.sleep(FLOWER_HANDOFF_MS);
      // A flower picked up since the checks above holds the input too. Once it is put down,
      // maybe right where this input lands, check and announce again before acting.
      const held = await waitWhileFlowerHeld(agentId);
      if (cursorClaimService.holderAgentId() !== agentId) return claimEnded();
      if (!held) break;
      afterHold = true;
    }
    const r = await run();
    if (r.ok && movesPointer) lastSet.set(agentId, { ...at, at: Date.now() });
    return r.ok ? json({ ok: true, simulated: false }) : json({ ok: false, error: fail(r) });
  };

  switch (op) {
    case 'move':
    case 'click': {
      const t = resolveSpec(agentId, input.target, input.x, input.y);
      if ('error' in t) return json({ ok: false, error: t.error });
      if (op === 'click' && t.el && DANGER_LABEL.test(t.el.label) && !approved) {
        return needsApproval(t.el.label);
      }
      // A raw-coordinate click with no look on record has no label to gate on.
      if (op === 'click' && realInput && !lastLook.has(agentId)) {
        return json({
          ok: false,
          error:
            'call op:look first so the click can be checked, then click by element id or coordinates',
        });
      }
      const button = input.button === 'right' ? 'right' : 'left';
      return finish(
        op === 'click' ? 'click' : 'move',
        t.point,
        () => runMouse(op, t.point.x, t.point.y, button),
        true,
        { points: [t.point] }
      );
    }
    case 'drag': {
      const f = resolveSpec(agentId, input.from);
      const t = resolveSpec(agentId, input.to);
      if ('error' in f) return json({ ok: false, error: `from: ${f.error}` });
      if ('error' in t) return json({ ok: false, error: `to: ${t.error}` });
      const risky = [f.el, t.el].find((e) => e && DANGER_LABEL.test(e.label));
      if (risky && !approved) return needsApproval(risky.label);
      return finish(
        'drag',
        t.point,
        () => runInput('drag', { fx: f.point.x, fy: f.point.y, tx: t.point.x, ty: t.point.y }),
        true,
        { points: [f.point, t.point] }
      );
    }
    case 'scroll': {
      const dy = Number(input.dy);
      if (!Number.isFinite(dy)) return json({ ok: false, error: 'dy must be a number' });
      const hasXY =
        input.x != null &&
        input.y != null &&
        Number.isFinite(Number(input.x)) &&
        Number.isFinite(Number(input.y));
      const at = hasXY ? { x: Number(input.x), y: Number(input.y) } : pos;
      return finish(
        'move',
        at,
        () => runInput('scroll', { dy: Math.max(-100, Math.min(100, dy)), ...(hasXY ? at : {}) }),
        hasXY,
        { points: hasXY ? [at] : null }
      );
    }
    case 'type':
    case 'key': {
      const text = op === 'type' ? String(input.text ?? '') : '';
      const combo = op === 'key' ? String(input.combo ?? '') : '';
      if (op === 'type' && !text) return json({ ok: false, error: 'text is required' });
      if (op === 'key' && !combo)
        return json({ ok: false, error: 'combo is required (e.g. cmd+s)' });
      let target: LookEl | undefined;
      if (typeof input.target === 'string') {
        target = lastLook.get(agentId)?.find((e) => e.id === input.target);
        if (!target) return json({ ok: false, error: `unknown element "${input.target}"` });
        if (isSecure(target)) {
          return json({ ok: false, error: 'Refusing to type into a password/secret field.' });
        }
      }
      let focusedLabel = '';
      if (realInput) {
        const f = await runAx('focus');
        if (!f.ok) return json({ ok: false, error: fail(f) });
        if (
          isSecure({
            role: String(f.role ?? ''),
            subrole: String(f.subrole ?? ''),
            label: String(f.label ?? ''),
          })
        ) {
          return json({ ok: false, error: 'Refusing to type into a password/secret field.' });
        }
        focusedLabel = String(f.label ?? '');
      }
      // Enter or a trailing newline commits whatever has focus: gate it like a click.
      const commits = op === 'key' ? COMMIT_KEY.test(combo.trim()) : TRAILING_NEWLINE.test(text);
      if (commits && !approved) {
        const label = [target?.label, focusedLabel].find((l) => l && DANGER_LABEL.test(l));
        if (label) return needsApproval(label);
      }
      // Keystrokes go to the focused app; the flower never takes the keyboard.
      return finish(
        'click',
        pos,
        () => (op === 'type' ? runInput('type', { text }) : runInput('key', { combo })),
        false,
        'keys'
      );
    }
  }
  return json({ ok: false, error: `unknown op "${op}"` });
};

const tool: ToolHandler = async (input, settings, context) => {
  const reply = await computerTool(input, settings, context);
  if (context?.agentId && typeof reply === 'string' && reply.includes('"error"')) {
    emitErrorCursor(context.agentId, reply, await loadAgentRow(context.agentId));
  }
  return reply;
};

export default tool;

/** Visual-only emote at the agent's last known point. No claim, input or screen read. */
export async function emitAvatarEmote(
  agentId: string,
  animation: AvatarEmote | undefined,
  label?: string,
  expression?: EmotionId
): Promise<boolean> {
  const at = lastPos.get(agentId);
  if (!at) return false;
  const row = await loadAgentRow(agentId);
  const faces: Record<AvatarEmote, EmotionId> = {
    spin: 'surprised',
    hyper: 'happy',
    laugh: 'happy',
    cry: 'worried',
    celebrate: 'proud',
    angry: 'angry',
  };
  emitCursor(
    row,
    'idle',
    at,
    label,
    expression ?? (animation ? faces[animation] : 'neutral'),
    animation
  );
  return true;
}
