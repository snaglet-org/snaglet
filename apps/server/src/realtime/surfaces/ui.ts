/**
 * Addressed transport for agent-driven UI navigation. Workspace events
 * broadcast to every client, but navigating one user's screen must not move
 * every client's panes, so this unicasts to the user's live connections
 * (`wsService.sendToClient`). It owns the connection registry (filled by
 * `ui.register_client`, pruned on disconnect), `emitNavigatePane`,
 * `requestPaneLayout` (correlated by `requestId`, times out, never hangs) and
 * the multi-client policy in `selectTargetClients`. Wire types live in
 * `@snaglet/shared/types/workspace-events`.
 */

import { randomUUID } from 'node:crypto';
import { wsService } from '@server/services/WebSocketService';
import { logger } from '@server/config/logger';
import {
  UI_EVENT_CHANNEL,
  isSidebarTabId,
  clampSidebarWidth,
  parseSidebarTarget,
  isSidebarInspection,
  isSidebarError,
} from '@snaglet/shared/types';
import type {
  SidebarCommand,
  SidebarSnapshot,
  SidebarError,
  UiSidebarRequestEvent,
  UiSidebarResponseEvent,
  Actor,
  PaneNavigationCommand,
  PaneLayoutSnapshot,
  UiNavigatePaneEvent,
  UiRequestPaneLayoutEvent,
  UiPaneLayoutResponseEvent,
  UiRegisterClientEvent,
} from '@snaglet/shared/types';

// Connection registry: userId -> live clientId(s)

/** Per-connection record. `lastActiveAt` drives the most-recent multi-client policy. */
interface RegisteredConnection {
  clientId: string;
  userId: string;
  lastActiveAt: number;
}

/** userId -> (clientId -> connection). */
const connectionsByUser = new Map<string, Map<string, RegisteredConnection>>();
/** clientId -> userId, for O(1) prune on disconnect. */
const userByClient = new Map<string, string>();

function registerConnection(userId: string, clientId: string): void {
  unregisterConnection(clientId); // Profile changes must not leave a stale owner.
  let byClient = connectionsByUser.get(userId);
  if (!byClient) {
    byClient = new Map<string, RegisteredConnection>();
    connectionsByUser.set(userId, byClient);
  }
  byClient.set(clientId, { clientId, userId, lastActiveAt: Date.now() });
  userByClient.set(clientId, userId);
  logger.info('[ui] client registered', { userId, clientId });
}

function unregisterConnection(clientId: string): void {
  const userId = userByClient.get(clientId);
  if (!userId) return;
  userByClient.delete(clientId);
  const byClient = connectionsByUser.get(userId);
  if (byClient) {
    byClient.delete(clientId);
    if (byClient.size === 0) connectionsByUser.delete(userId);
  }
}

/** Mark a connection most-recently-active (used by the (b) policy). */
function touchConnection(clientId: string): void {
  const userId = userByClient.get(clientId);
  if (!userId) return;
  const conn = connectionsByUser.get(userId)?.get(clientId);
  if (conn) conn.lastActiveAt = Date.now();
}

// Multi-client policy: with two or more clients connected for one user,
// navigate all of them or only the most recently active one (the default).

type MultiClientPolicy = 'all' | 'most-recent';

const MULTI_CLIENT_POLICY: MultiClientPolicy = 'most-recent';

/**
 * Resolve which of a user's live connections an addressed event targets: the
 * one place the multi-client policy applies. Returns [] when the user has
 * no live connection (caller treats that as "not viewable").
 */
function selectTargetClients(userId: string): RegisteredConnection[] {
  const byClient = connectionsByUser.get(userId);
  if (!byClient || byClient.size === 0) return [];
  const conns = [...byClient.values()];
  if (MULTI_CLIENT_POLICY === 'all') return conns;
  // Most recently active: the single newest connection.
  return [conns.reduce((newest, c) => (c.lastActiveAt > newest.lastActiveAt ? c : newest))];
}

// Direct client resolution: for a single-user desktop app, find the connected
// client without a userId lookup.

/**
 * Resolve the userId of the most-recently-active connected client, without
 * the caller needing to know who the user is. Returns null when no client
 * is registered (tool returns structured `viewable: false`).
 *
 * This is the "Option 2" path: address the one connected browser directly.
 */
export function resolveAnyConnectedUserId(): string | null {
  if (connectionsByUser.size === 0) return null;

  // If only one user is connected (desktop single-user), return them.
  if (connectionsByUser.size === 1) {
    return connectionsByUser.keys().next().value ?? null;
  }

  // Multiple users: pick the one with the most-recently-active connection.
  let bestUserId: string | null = null;
  let bestTime = 0;
  for (const [userId, byClient] of connectionsByUser) {
    for (const conn of byClient.values()) {
      if (conn.lastActiveAt > bestTime) {
        bestTime = conn.lastActiveAt;
        bestUserId = userId;
      }
    }
  }
  return bestUserId;
}

// Request/response correlation for layout queries

interface PendingLayoutRequest {
  resolve: (snapshot: PaneLayoutSnapshot) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingLayoutRequests = new Map<string, PendingLayoutRequest>();

// Public result shapes

/** Result of a navigation emit: which clients (if any) were addressed. */
export interface NavigateResult {
  delivered: boolean;
  clientCount: number;
}

/** Result of a layout request: either a snapshot, or a structured reason. */
export type LayoutResult =
  | { viewable: true; layout: PaneLayoutSnapshot }
  | { viewable: false; reason: 'no_active_client' | 'layout_timeout' };

// Emit helpers

/**
 * Unicast a navigation command to the user's live client(s) per policy.
 * Fire-and-forget: returns immediately with how many clients were addressed.
 * When no client is connected, `delivered` is false (agent says "I can't see
 * your screen right now").
 */
export function emitNavigatePane(params: {
  userId: string;
  command: PaneNavigationCommand;
  actor: Actor;
}): NavigateResult {
  const targets = selectTargetClients(params.userId);
  if (targets.length === 0) {
    logger.info('[ui] navigate_pane: no active client', { userId: params.userId });
    return { delivered: false, clientCount: 0 };
  }

  const event: UiNavigatePaneEvent = {
    type: 'ui.navigate_pane',
    ts: new Date().toISOString(),
    actor: params.actor,
    paneKey: params.command.paneKey ?? null,
    mode: params.command.mode,
    splitZone: params.command.splitZone,
    newPaneRatio: params.command.newPaneRatio,
    target: params.command.target,
  };

  let delivered = 0;
  for (const conn of targets) {
    const ok = wsService.sendToClient(conn.clientId, {
      type: 'ui.navigate_pane',
      channel: UI_EVENT_CHANNEL,
      payload: event,
    });
    if (ok) delivered += 1;
    else unregisterConnection(conn.clientId); // prune dead connection
  }

  return { delivered: delivered > 0, clientCount: delivered };
}

/**
 * Ask the user's client for its live pane layout and await the answer.
 * Resolves with the snapshot, or a structured { viewable: false, reason }
 * within `timeoutMs` — never hangs the agent turn.
 *
 * When the (b) policy is active we query the single most-recently-active
 * client; under (a) we query the first available and use whichever answers.
 */
export async function requestPaneLayout(params: {
  userId: string;
  timeoutMs?: number;
  actor: Actor;
}): Promise<LayoutResult> {
  const timeoutMs = params.timeoutMs ?? 3000;
  const targets = selectTargetClients(params.userId);
  if (targets.length === 0) {
    return { viewable: false, reason: 'no_active_client' };
  }

  const requestId = randomUUID();
  const event: UiRequestPaneLayoutEvent = {
    type: 'ui.request_pane_layout',
    ts: new Date().toISOString(),
    actor: params.actor,
    requestId,
  };

  const snapshot = await new Promise<PaneLayoutSnapshot | null>((resolve) => {
    const timer = setTimeout(() => {
      pendingLayoutRequests.delete(requestId);
      resolve(null);
    }, timeoutMs);

    pendingLayoutRequests.set(requestId, {
      resolve: (snap) => resolve(snap),
      timer,
    });

    let sentToAny = false;
    for (const conn of targets) {
      const ok = wsService.sendToClient(conn.clientId, {
        type: 'ui.request_pane_layout',
        channel: UI_EVENT_CHANNEL,
        payload: event,
      });
      if (ok) sentToAny = true;
      else unregisterConnection(conn.clientId);
    }

    // Every target was already dead — resolve immediately as not viewable.
    if (!sentToAny) {
      clearTimeout(timer);
      pendingLayoutRequests.delete(requestId);
      resolve(null);
    }
  });

  if (snapshot === null) {
    // Distinguish "nobody connected at send time" from "asked, nobody answered".
    return {
      viewable: false,
      reason:
        selectTargetClients(params.userId).length === 0 ? 'no_active_client' : 'layout_timeout',
    };
  }
  return { viewable: true, layout: snapshot };
}

export type SidebarResult =
  | { success: true; state: SidebarSnapshot }
  | {
      success: false;
      reason: 'no_active_client' | 'sidebar_timeout' | SidebarError;
    };

const pendingSidebarRequests = new Map<
  string,
  {
    clientIds: Set<string>;
    inspect: boolean;
    command: SidebarCommand;
    resolve: (result: SidebarResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

/** Sidebar mutations are acknowledged only after the client commits its state. */
export async function requestSidebar(params: {
  userId: string;
  command: SidebarCommand;
  actor: Actor;
  timeoutMs?: number;
}): Promise<SidebarResult> {
  const targets = selectTargetClients(params.userId);
  if (!targets.length) return { success: false, reason: 'no_active_client' };
  const requestId = randomUUID();
  const event: UiSidebarRequestEvent = {
    type: 'ui.sidebar_request',
    ts: new Date().toISOString(),
    requestId,
    command: params.command,
    actor: params.actor,
  };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingSidebarRequests.delete(requestId);
      resolve({ success: false, reason: 'sidebar_timeout' });
    }, params.timeoutMs ?? 3000);
    pendingSidebarRequests.set(requestId, {
      timer,
      resolve,
      inspect: params.command.op === 'inspect',
      command: params.command,
      clientIds: new Set(targets.map((target) => target.clientId)),
    });
    let sent = false;
    for (const target of targets) {
      if (
        wsService.sendToClient(target.clientId, {
          type: event.type,
          channel: UI_EVENT_CHANNEL,
          payload: event,
        })
      )
        sent = true;
      else unregisterConnection(target.clientId);
    }
    if (!sent) {
      clearTimeout(timer);
      pendingSidebarRequests.delete(requestId);
      resolve({ success: false, reason: 'no_active_client' });
    }
  });
}

// Wiring: register the WS handlers and disconnect pruning. Call once at boot.

let initialized = false;

/**
 * Install the `ui` surface: client->server handlers (`ui.register_client`,
 * `ui.pane_layout_response`) and disconnect pruning. Idempotent.
 */
export function initUiSurface(): void {
  if (initialized) return;
  initialized = true;

  wsService.registerHandler<UiRegisterClientEvent>('ui.register_client', (payload, meta) => {
    if (!payload?.userId || !meta.clientId) return;
    registerConnection(payload.userId, meta.clientId);
  });

  wsService.registerHandler<UiPaneLayoutResponseEvent>(
    'ui.pane_layout_response',
    (payload, meta) => {
      if (meta.clientId) touchConnection(meta.clientId);
      const pending = payload?.requestId ? pendingLayoutRequests.get(payload.requestId) : undefined;
      if (!pending) return; // late / unknown response — drop silently
      clearTimeout(pending.timer);
      pendingLayoutRequests.delete(payload.requestId);
      pending.resolve(payload.layout);
    }
  );

  wsService.registerHandler<UiSidebarResponseEvent>('ui.sidebar_response', (payload, meta) => {
    const pending = payload?.requestId ? pendingSidebarRequests.get(payload.requestId) : undefined;
    if (!pending || !meta.clientId || !pending.clientIds.has(meta.clientId)) return;
    if (
      !payload.state ||
      typeof payload.state.open !== 'boolean' ||
      !isSidebarTabId(payload.state.active_tab)
    )
      return;
    if (
      payload.state.width_px !== undefined &&
      (typeof payload.state.width_px !== 'number' || !Number.isFinite(payload.state.width_px))
    )
      return;
    if (payload.error !== undefined && !isSidebarError(payload.error)) return;
    if (!payload.error) {
      if (
        (pending.inspect || payload.state.detail !== undefined) &&
        !isSidebarInspection(payload.state.detail)
      )
        return;
      if (
        pending.command.op === 'open' &&
        (!payload.state.open ||
          (pending.command.tab !== undefined && payload.state.active_tab !== pending.command.tab))
      )
        return;
      if (pending.command.op === 'close' && payload.state.open) return;
      if (
        pending.command.op === 'resize' &&
        (typeof pending.command.width_px !== 'number' ||
          !Number.isFinite(pending.command.width_px) ||
          payload.state.width_px !== clampSidebarWidth(pending.command.width_px))
      )
        return;
      if (
        pending.command.op === 'scroll' &&
        (!payload.state.open ||
          payload.state.scrolled !== true ||
          typeof payload.state.at_bottom !== 'boolean' ||
          [payload.state.scroll_top, payload.state.scroll_height, payload.state.client_height].some(
            (value) => typeof value !== 'number' || !Number.isFinite(value)
          ))
      )
        return;
      if (pending.command.op === 'expand' || pending.command.op === 'collapse') {
        if (
          !payload.state.open ||
          payload.state.active_tab !== parseSidebarTarget(pending.command.target ?? '')?.tab ||
          payload.state.target !== pending.command.target ||
          payload.state.expanded !== (pending.command.op === 'expand')
        )
          return;
      }
    }
    touchConnection(meta.clientId);
    clearTimeout(pending.timer);
    pendingSidebarRequests.delete(payload.requestId);
    pending.resolve(
      payload.error
        ? { success: false, reason: payload.error }
        : {
            success: true,
            state: {
              ...(payload.state.width_px !== undefined ? { width_px: payload.state.width_px } : {}),
              open: payload.state.open,
              active_tab: payload.state.active_tab,
              ...(payload.state.detail ? { detail: payload.state.detail } : {}),
              ...(payload.state.target !== undefined && pending.command.op !== 'scroll'
                ? { target: payload.state.target, expanded: payload.state.expanded }
                : {}),
              ...(pending.command.op === 'scroll'
                ? {
                    scrolled: true,
                    scroll_top: payload.state.scroll_top,
                    scroll_height: payload.state.scroll_height,
                    client_height: payload.state.client_height,
                    at_bottom: payload.state.at_bottom,
                  }
                : {}),
            },
          }
    );
  });

  wsService.onDisconnect((clientId) => {
    unregisterConnection(clientId);
  });

  logger.info('[ui] surface initialized (addressed transport)');
}
