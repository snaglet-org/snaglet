import { resolveAgentCursor, type AgentCursorState } from '@snaglet/shared/constants/agentCursor';
import { isEmotionId } from '@snaglet/shared/cursor';
import { Router, Request, Response } from 'express';
import { Agents } from '@snaglet/db/tables/agents';
import { cursorClaimService } from '@server/services/CursorClaimService';
import { cursorApprovalService } from '@server/services/CursorApprovalService';
import {
  applyFlowerChoice,
  emitCursor,
  forgetCursorPosition,
} from '@server/services/ToolService/tools/system/computer/tool';
import { agentCursorSessions } from '@server/services/agentCursorSessions';
import { getBrowserController } from '@server/services/BrowserController';
import {
  isAskWindowActive,
  markAskWindowAlive,
  markSystemOverlayAlive,
} from '@server/services/systemCursorOverlay';

const router = Router();

const MAX_ID_LENGTH = 200;
/** Screen points; generous for any display arrangement, small enough to rule out junk. */
const MAX_SCREEN_COORD = 100_000;

const idField = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH ? v : null;

const screenCoord = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_SCREEN_COORD ? v : null;

function screenPoint(v: unknown): { x: number; y: number } | null {
  const p = v as { x?: unknown; y?: unknown } | null | undefined;
  const x = screenCoord(p?.x);
  const y = screenCoord(p?.y);
  return x === null || y === null ? null : { x, y };
}

/**
 * Who a flower action is for: the agent and the cursor session the page saw, so a late
 * action can never land on the agent's next session. `pointer` is where the person's mouse
 * was (screen points), absent for a keyboard ×.
 */
function flowerTarget(
  body: unknown
): { agentId: string; session: string; pointer?: { x: number; y: number } } | null {
  const b = (body ?? {}) as { agentId?: unknown; session?: unknown; pointer?: unknown };
  const agentId = idField(b.agentId);
  const session = idField(b.session);
  if (!agentId || !session) return null;
  if (b.pointer === undefined) return { agentId, session };
  const pointer = screenPoint(b.pointer);
  return pointer ? { agentId, session, pointer } : null;
}

/** Heartbeat from the system-wide overlay page, with the main display's size in points. */
router.post('/overlay-heartbeat', (req: Request, res: Response) => {
  const b = (req.body ?? {}) as { width?: unknown; height?: unknown };
  const width = screenCoord(b.width);
  const height = screenCoord(b.height);
  markSystemOverlayAlive(
    Date.now(),
    width !== null && height !== null && width > 0 && height > 0 ? { width, height } : null
  );
  res.json({ ok: true });
});

/** Heartbeat from the native ask window's page. */
router.post('/ask-overlay-heartbeat', (_req: Request, res: Response) => {
  markAskWindowAlive();
  res.json({ ok: true });
});

/** Whether the native ask window is running (the in-app pop-ups stand down). */
router.get('/ask-overlay-status', (_req: Request, res: Response) => {
  res.json({ active: isAskWindowActive() });
});

/** Kill switch: revoke the cursor claim and hide the holder's flower. */
router.post('/stop', async (_req: Request, res: Response) => {
  cursorApprovalService.revokeAll();
  // Esc stops the browser too: close every agent tab (a grant alone would not).
  const browserTabsClosed = await getBrowserController()
    .stopAll()
    .catch(() => 0);
  const former = cursorClaimService.revoke();
  if (former) {
    forgetCursorPosition(former.agentId);
    const agent = await Agents.findById(former.agentId).catch(() => null);
    emitCursor(
      {
        id: former.agentId,
        name: former.name,
        cursor_flower: agent?.cursorFlower ?? null,
        cursor_color: agent?.cursorColor ?? null,
      },
      'hidden',
      { x: 0, y: 0 }
    );
  }
  res.json({ ok: true, revoked: former?.agentId ?? null, browserTabsClosed });
});

/**
 * The person hid an agent's flower (its × or dragged off the edge) for the rest of its cursor
 * session. The agent keeps working; only /stop stops it.
 */
router.post('/cursor/dismiss', (req: Request, res: Response) => {
  const target = flowerTarget(req.body);
  if (!target) {
    res.status(400).json({ ok: false, error: 'agentId and session are required' });
    return;
  }
  if (!applyFlowerChoice(target.agentId, { dismiss: true }, target)) {
    res.status(404).json({ ok: false });
    return;
  }
  res.json({ ok: true });
});

/** The person dropped an agent's flower here (screen points): it stays put for the session. */
router.post('/cursor/park', (req: Request, res: Response) => {
  const target = flowerTarget(req.body);
  const at = screenPoint(req.body);
  if (!target || !at) {
    res.status(400).json({ ok: false, error: 'agentId, session and numeric x and y are required' });
    return;
  }
  if (!applyFlowerChoice(target.agentId, { park: at }, target)) {
    res.status(404).json({ ok: false });
    return;
  }
  res.json({ ok: true });
});

/**
 * The person pressed (`held: true`) or let go of (`held: false`) an agent's flower without
 * parking it. While held, the agent's input waits, so the pointer is never moved out from
 * under them. The page renews a long hold; an unrenewed one lapses on its own.
 */
router.post('/cursor/grab', (req: Request, res: Response) => {
  const target = flowerTarget(req.body);
  const held = (req.body as { held?: unknown } | null)?.held;
  if (!target || typeof held !== 'boolean') {
    res.status(400).json({ ok: false, error: 'agentId, session and boolean held are required' });
    return;
  }
  if (!agentCursorSessions.grab(target.agentId, target.session, held)) {
    res.status(404).json({ ok: false });
    return;
  }
  res.json({ ok: true });
});

/** Every flower's current hide/park choice, for an overlay that lost its connection. */
router.get('/cursor/flowers', (_req: Request, res: Response) => {
  res.json({ flowers: agentCursorSessions.snapshot() });
});

/** The app's answer to a cursor approval request. */
router.post('/approval', (req: Request, res: Response) => {
  const { requestId, decision } = (req.body ?? {}) as { requestId?: unknown; decision?: unknown };
  if (decision !== 'allow' && decision !== 'allow-session' && decision !== 'deny') {
    res.status(400).json({ ok: false, error: 'decision must be allow, allow-session or deny' });
    return;
  }
  if (
    typeof requestId !== 'string' ||
    !cursorApprovalService.resolveApproval(requestId, decision)
  ) {
    res.status(404).json({ ok: false });
    return;
  }
  res.json({ ok: true });
});

/**
 * Dev only: play a short flower sequence so the overlay can be checked without an
 * agent. Pass `agentId` to move a real agent's flower (it then stays where it ends,
 * like a real cursor does); otherwise a made-up agent is used.
 */
router.post('/demo', async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    res.status(404).json({ ok: false });
    return;
  }
  const body = (req.body ?? {}) as {
    name?: string;
    flower?: string;
    agentId?: string;
    emotion?: string;
  };
  const row = body.agentId ? await Agents.findById(body.agentId).catch(() => null) : null;
  const agent = row
    ? {
        id: row.id,
        name: row.name,
        cursor_flower: row.cursorFlower ?? null,
        cursor_color: row.cursorColor ?? null,
      }
    : { id: 'demo-agent', name: body.name || 'Demo', cursor_flower: body.flower ?? null };
  // `emotion` plays a single moment with that face (for example 'stumped') so it can
  // be seen without a model run.
  if (body.emotion && isEmotionId(body.emotion)) {
    emitCursor(
      agent,
      'idle',
      { x: 760, y: 420 },
      'That did not work: element not found',
      body.emotion
    );
    res.json({ ok: true, steps: 1, agent: agent.name, emotion: body.emotion });
    return;
  }
  const steps: Array<[AgentCursorState, number, number, string]> = [
    ['move', 300, 260, 'looking around'],
    ['move', 760, 420, 'opening the calendar'],
    ['click', 760, 420, 'clicking'],
    ['move', 1100, 300, 'dragging to split'],
    ['idle', 1100, 300, ''],
  ];
  steps.forEach(([state, x, y, label], i) => {
    setTimeout(() => emitCursor(agent, state, { x, y }, label), i * 1500);
  });
  res.json({ ok: true, steps: steps.length, agent: agent.name });
});

/**
 * Dev only: raise a real approval request (the same service, events and app
 * card an agent's claim uses) for a made-up agent, so the prompt can be tried
 * without a model. It resolves with the answer; it never takes the cursor.
 */
router.post('/demo-approval', async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    res.status(404).json({ ok: false });
    return;
  }
  const body = (req.body ?? {}) as {
    name?: string;
    flower?: string;
    kind?: 'cursor' | 'browser' | 'handoff';
    profile?: string;
    reason?: string;
    timeoutMs?: number;
  };
  const kind = body.kind === 'browser' || body.kind === 'handoff' ? body.kind : 'cursor';
  const { flower, color } = resolveAgentCursor('demo-agent', body.flower ?? null, null);
  const outcome = await cursorApprovalService.requestApproval({
    agentId: 'demo-agent',
    name: body.name || 'Demo',
    reason: body.reason ?? (kind === 'handoff' ? 'Finish signing in' : 'Open the calendar'),
    flower,
    color,
    kind,
    profile: kind === 'browser' ? (body.profile ?? 'main') : undefined,
    timeoutMs: Math.min(Math.max(Number(body.timeoutMs) || 45_000, 1_000), 120_000),
  });
  res.json({ ok: true, outcome });
});

export default router;
