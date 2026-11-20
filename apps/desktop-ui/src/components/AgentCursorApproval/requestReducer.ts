import {
  AGENT_CURSOR_REQUEST_EVENT,
  AGENT_CURSOR_REQUEST_RESOLVED_EVENT,
  type AgentCursorRequestEvent,
  type AgentCursorRequestResolvedEvent,
} from '@snaglet/shared/constants/agentCursor';

/** Pending approval requests in arrival order. */
export type PendingRequest = AgentCursorRequestEvent & { expired?: boolean };
export type RequestList = PendingRequest[];

function isRequestEvent(v: unknown): v is AgentCursorRequestEvent {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.requestId === 'string' &&
    typeof e.agentId === 'string' &&
    typeof e.name === 'string' &&
    typeof e.flower === 'string' &&
    typeof e.color === 'string' &&
    typeof e.expiresAt === 'number'
  );
}

function isResolvedEvent(v: unknown): v is AgentCursorRequestResolvedEvent {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return typeof e.requestId === 'string' && typeof e.decision === 'string';
}

export function addRequest(list: RequestList, req: AgentCursorRequestEvent): RequestList {
  if (list.some((r) => r.requestId === req.requestId)) {
    return list.map((r) => (r.requestId === req.requestId ? { ...req } : r));
  }
  return [...list, req];
}

/** Answered elsewhere, or timed out server-side. */
export function resolveRequest(list: RequestList, requestId: string): RequestList {
  return list.some((r) => r.requestId === requestId)
    ? list.filter((r) => r.requestId !== requestId)
    : list;
}

/** Drop requests whose deadline has passed. */
export function pruneExpiredRequests(list: RequestList, now: number): RequestList {
  const next = list.filter((r) => r.expiresAt > now);
  return next.length === list.length ? list : next;
}

/** Flag a card as expired (e.g. the POST 404'd) so the UI can show it briefly. */
export function markExpired(list: RequestList, requestId: string): RequestList {
  return list.map((r) => (r.requestId === requestId ? { ...r, expired: true } : r));
}

/** Pull a request / resolution out of a ws frame, whatever envelope the server used. */
export function extractRequestMessage(
  message: unknown
):
  | { kind: 'request'; event: AgentCursorRequestEvent }
  | { kind: 'resolved'; event: AgentCursorRequestResolvedEvent }
  | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as { type?: unknown; payload?: unknown };
  const inner = m.payload as { type?: unknown; payload?: unknown } | undefined;
  const frames: Array<{ type?: unknown; payload?: unknown } | undefined> = [m, inner];
  for (const f of frames) {
    if (!f) continue;
    if (f.type === AGENT_CURSOR_REQUEST_EVENT && isRequestEvent(f.payload))
      return { kind: 'request', event: f.payload };
    if (f.type === AGENT_CURSOR_REQUEST_RESOLVED_EVENT && isResolvedEvent(f.payload))
      return { kind: 'resolved', event: f.payload };
  }
  return null;
}

/** The verb phrase for what an agent is asking to use. */
export function approvalPhrase(req: Pick<AgentCursorRequestEvent, 'kind'>): string {
  if (req.kind === 'handoff') return 'needs you to finish a step in the browser:';
  return req.kind === 'browser'
    ? 'wants to use your signed-in browser'
    : 'wants to use your cursor';
}

/** Button labels per request kind. A handoff has one way forward (Done) and Cancel. */
export function approvalButtons(req: Pick<AgentCursorRequestEvent, 'kind'>): {
  allow: string;
  session: string | null;
  deny: string;
} {
  return req.kind === 'handoff'
    ? { allow: 'Done', session: null, deny: 'Cancel' }
    : { allow: 'Allow once', session: 'Allow for this session', deny: 'Deny' };
}
