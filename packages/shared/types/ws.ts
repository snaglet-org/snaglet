/**
 * WebSocket message contract shared between server and client.
 *
 * All messages follow a single envelope format:
 *   { type, channel?, payload, id? }
 *
 * `type`    — identifies the message kind (e.g. "gateway:status")
 * `channel` — optional room/topic for scoped subscriptions
 * `payload` — message data (typed per message kind)
 * `id`      — optional correlation id for request/response pairing
 */

export interface WsMessage<T = unknown> {
  type: string;
  channel?: string;
  payload: T;
  id?: string;
}

/**
 * Client → server subscription message.
 * Subscribe to or unsubscribe from a named channel.
 */
export interface WsSubscribeMessage {
  type: 'subscribe' | 'unsubscribe';
  channel: string;
}

/**
 * Server → client: acknowledge a subscription.
 */
export interface WsSubscribeAck {
  type: 'subscribed' | 'unsubscribed';
  channel: string;
}

/**
 * Server → client: connection established.
 */
export interface WsConnectedMessage {
  type: 'connected';
  payload: { clientId: string };
}

/**
 * Server → client: error.
 */
export interface WsErrorMessage {
  type: 'error';
  payload: { message: string; code?: string };
}

/** Capture sources supported by a thread-scoped vision session. */
export type VisionSessionSource = 'screen' | 'camera' | 'both';

/** Server-owned lifecycle exposed to every composer viewing the thread. */
export type VisionSessionPhase = 'inactive' | 'starting' | 'active' | 'stopping' | 'error';

export interface VisionSessionStatePayload {
  threadId: string;
  phase: VisionSessionPhase;
  enabled: boolean;
  source: VisionSessionSource | null;
  sessionId: string | null;
  sessionDir: string | null;
  ready: boolean;
  error: string | null;
  updatedAt: string;
}

export interface VisionSessionStartPayload {
  threadId: string;
  source: VisionSessionSource;
}

export interface VisionSessionThreadPayload {
  threadId: string;
}

export interface VisionSessionErrorPayload {
  threadId: string;
  message: string;
}

/** Server → the browser that granted access: capture its exact selected stream. */
export interface VisionCaptureRequestPayload {
  threadId: string;
  requestId: string;
  source: Exclude<VisionSessionSource, 'both'>;
}

/**
 * Why a browser-side capture could not produce a frame. Each code maps to one
 * distinct remediation on the server side (see `visionCaptureErrors.ts`), so a
 * denied camera permission, a missing device, a busy device, and an ended
 * stream never collapse into one generic failure.
 */
export type VisionCaptureErrorCode =
  | 'permission_denied'
  | 'device_not_found'
  | 'device_in_use'
  | 'stream_inactive'
  | 'frame_timeout'
  | 'frame_encoding_failed'
  | 'unsupported'
  | 'unknown';

/** Browser → server: one frame from its selected getDisplayMedia/getUserMedia stream. */
export interface VisionCaptureResponsePayload {
  threadId: string;
  requestId: string;
  source: Exclude<VisionSessionSource, 'both'>;
  mimeType?: 'image/jpeg' | 'image/png';
  base64?: string;
  error?: string;
  /** Present with `error`; the server turns it into an actionable message. */
  errorCode?: VisionCaptureErrorCode;
}

/** A single temporary on-demand frame streamed outside chat history for this turn. */
export interface VisionPreviewFramePayload {
  threadId: string;
  sessionId: string;
  frameId: string;
  source: Exclude<VisionSessionSource, 'both'>;
  frameTs: string;
  mimeType: 'image/jpeg' | 'image/png';
  deliveryUrl: string;
  byteLength: number;
  expiresAt: string;
  updatedAt: string;
}

/** Clear temporary preview pixels after promotion, turn teardown, switch, or stop. */
export interface VisionPreviewClearPayload {
  threadId: string;
  sessionId: string;
  frameId: string;
  source: Exclude<VisionSessionSource, 'both'>;
  updatedAt: string;
}

/**
 * Server → client: the panel execution token, pushed once right after
 * `connected`. Gates POST /api/tools/execute + /execute/test — see the
 * server's middleware/panelAuth.ts and the client's utils/panelToken.ts for
 * the full picture (this is the Vite-dev-mode delivery channel; the packaged
 * desktop app gets the same value synchronously via Tauri's
 * initialization_script instead).
 */
export interface WsPanelTokenMessage {
  type: 'panel-token';
  payload: { token: string };
}

/** Well-known system message types */
export type WsSystemType =
  | 'connected'
  | 'subscribe'
  | 'unsubscribe'
  | 'subscribed'
  | 'unsubscribed'
  | 'ping'
  | 'pong'
  | 'error'
  | 'panel-token';

/** Handler function for a specific message type on the server */
export type WsMessageHandler<T = unknown> = (
  payload: T,
  meta: {
    clientId: string;
    channel?: string;
    messageId?: string;
    externalCaller?: { memberId: string; name: string };
  }
) => void | Promise<void>;

/** WebSocket route constant */
export const WS_PATH = '/ws';
