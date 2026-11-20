/**
 * appleChatProtocol — the wire contract with the `snaglet-apple-chat` Swift sidecar.
 *
 * Unlike the STT sidecar (length-prefixed binary frames in, NDJSON out), the
 * chat sidecar speaks newline-delimited JSON in both directions:
 *
 *   host → sidecar (stdin): one JSON object per line
 *     {"id":"...", "prompt":"...", "instructions":"...", "maxTokens":123}
 *     {"id":"...", "cancel":true}
 *   sidecar → host (stdout): newline-delimited JSON, one object per line
 *     {"type":"ready"}
 *     {"type":"token","id":..,"text":..}
 *     {"type":"done","id":..,"stopReason":"end_turn"|"aborted"}
 *     {"type":"error","id":..,"message":..}
 *     {"type":"availability","available":true}
 *     {"type":"availability","available":false,"reason":"appleIntelligenceNotEnabled"}
 *
 * See native/apple-chat/chat.swift's header comment for the canonical spec
 * and the two constraints (snapshot diffing, per-session mutex) this
 * contract exists to support.
 */

import { safeJsonParse } from '@snaglet/shared/utils';

/** One line the sidecar emits on stdout. */
export interface ChatLine {
  readonly type: 'ready' | 'token' | 'done' | 'error' | 'availability';
  readonly id?: string;
  readonly text?: string;
  readonly stopReason?: string;
  readonly message?: string;
  readonly available?: boolean;
  readonly reason?: string;
}

/** One request line the host writes to the sidecar's stdin. */
export interface ChatRequestLine {
  readonly id: string;
  readonly prompt?: string;
  readonly instructions?: string;
  readonly maxTokens?: number;
  readonly cancel?: boolean;
}

/** Encode a request as a single NDJSON line (including the trailing newline). */
export function encodeRequestLine(req: ChatRequestLine): string {
  return `${JSON.stringify(req)}\n`;
}

/**
 * A newline-delimited JSON parser for the sidecar's stdout. Feed it raw
 * stdout chunks; it invokes `onLine` for each complete, well-formed line and
 * buffers partial lines across chunk boundaries. Malformed lines are dropped.
 * (Same buffering strategy as appleSttProtocol's createLineParser.)
 */
export function createLineParser(onLine: (line: ChatLine) => void): (chunk: Buffer) => void {
  let buf = '';
  return (chunk: Buffer): void => {
    buf += chunk.toString('utf8');
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const raw = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (raw.length > 0) {
        const parsed = safeJsonParse<ChatLine | null>(raw, null);
        if (parsed && typeof parsed.type === 'string') onLine(parsed);
      }
      nl = buf.indexOf('\n');
    }
  };
}
