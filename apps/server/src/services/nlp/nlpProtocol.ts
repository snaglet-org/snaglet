/**
 * nlpProtocol — the wire contract with the `snaglet-nlp-helper` Swift daemon.
 *
 * Shared by {@link NlpHelperClient} (the real client) and the jest fake helper,
 * so both speak the exact same bytes. See native/nlp-helper/README.md for the
 * canonical spec. In short:
 *
 *   host → helper (stdin): length-prefixed binary frames
 *     [4-byte big-endian uint32 length][length bytes UTF-8 text]
 *   helper → host (stdout): newline-delimited JSON, one object per request,
 *     in the same order requests arrive (no request-id correlation — the host
 *     drives one request at a time via NlpHelperClient's serialized queue)
 *     {"entities":["Jane Doe","Acme Corp"],"language":"en"}
 *
 * Length-prefixing is used on the REQUEST side (not newline-delimited)
 * because message text can itself contain embedded newlines; the RESPONSE
 * side is safe as newline-delimited JSON because JSON already escapes
 * embedded newlines inside string values.
 */

import { safeJsonParse } from '@snaglet/shared/utils';

/** One line the helper emits on stdout — the parsed entity extraction result. */
export interface NlpResponseLine {
  readonly entities: string[];
  readonly language: string | null;
}

/** Encode a request frame: 4-byte BE length + UTF-8 text payload. */
export function encodeRequestFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/** True when a parsed JSON value has the shape of a valid response line. */
function isNlpResponseLine(value: unknown): value is NlpResponseLine {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.entities) &&
    v.entities.every((e) => typeof e === 'string') &&
    (v.language === null || typeof v.language === 'string')
  );
}

/**
 * A newline-delimited JSON parser for the helper's stdout. Feed it raw stdout
 * chunks; it invokes `onLine` for each complete, well-formed response line and
 * buffers partial lines across chunk boundaries. Malformed lines are dropped
 * (defensive — the helper is trusted, but a torn write should never crash the
 * server).
 */
export function createResponseLineParser(
  onLine: (line: NlpResponseLine) => void
): (chunk: Buffer) => void {
  let buf = '';
  return (chunk: Buffer): void => {
    buf += chunk.toString('utf8');
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const raw = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (raw.length > 0) {
        const parsed = safeJsonParse<unknown>(raw, null);
        if (isNlpResponseLine(parsed)) onLine(parsed);
      }
      nl = buf.indexOf('\n');
    }
  };
}

/**
 * A stdin frame parser (host-side, used by the fake helper in tests to decode
 * what NlpHelperClient wrote). Feed raw stdin chunks; invokes `onFrame` per
 * complete frame. Mirrors the real helper's own reader.
 */
export function createRequestFrameParser(onFrame: (text: string) => void): (chunk: Buffer) => void {
  let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  return (chunk: Buffer): void => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) break;
      onFrame(buf.subarray(4, 4 + len).toString('utf8'));
      buf = buf.subarray(4 + len);
    }
  };
}
