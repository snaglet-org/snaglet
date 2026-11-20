/**
 * appleSttProtocol — the wire contract with the `snaglet-apple-stt` Swift sidecar.
 *
 * Shared by {@link AppleSttEngine} (the real client) and the jest fake sidecar,
 * so both speak the exact same bytes. See native/apple-stt/README.md for the
 * canonical spec. In short:
 *
 *   host → sidecar (stdin): length-prefixed binary frames
 *     [1 byte opcode][4 byte big-endian uint32 length][length bytes payload]
 *       AUDIO    (0x01) payload = raw little-endian pcm16 mono @ --rate
 *       FINALIZE (0x02) payload empty — end the current utterance
 *   sidecar → host (stdout): newline-delimited JSON, one object per line
 *       {"type":"ready"|"partial"|"final","text":..,"tMs":..,"audioMs":..}
 *       {"type":"error","code":..,"message":..}   the sidecar can't run (exits 1)
 */

import { safeJsonParse } from '@snaglet/shared/utils';

const STT_OPCODE = {
  AUDIO: 0x01,
  FINALIZE: 0x02,
} as const;

/**
 * Why the sidecar can't run, as it reports it on an `error` line. Older
 * binaries never send one; the host treats their bare non-zero exit as 'failed'.
 */
export type SttFailureCode = 'unsupported-os' | 'locale' | 'assets' | 'not-authorized' | 'failed';

/** One line the sidecar emits on stdout. */
export interface SttLine {
  readonly type: 'ready' | 'partial' | 'final' | 'error';
  readonly text?: string;
  readonly tMs?: number;
  readonly audioMs?: number;
  /** `error` lines only. */
  readonly code?: string;
  /** `error` lines only: Apple's own description of the failure. */
  readonly message?: string;
}

/** Encode a control/audio frame (opcode + big-endian length + payload). */
function encodeFrame(opcode: number, payload?: Buffer): Buffer {
  const body = payload ?? Buffer.alloc(0);
  const header = Buffer.alloc(5);
  header[0] = opcode;
  header.writeUInt32BE(body.length, 1);
  return body.length > 0 ? Buffer.concat([header, body]) : header;
}

/** Encode an AUDIO frame from a pcm16 chunk (little-endian bytes). */
export function encodeAudioFrame(pcm16: Int16Array): Buffer {
  const bytes = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
  return encodeFrame(STT_OPCODE.AUDIO, bytes);
}

/** Encode a FINALIZE frame (empty payload). */
export function encodeFinalizeFrame(): Buffer {
  return encodeFrame(STT_OPCODE.FINALIZE);
}

/**
 * A newline-delimited JSON parser for the sidecar's stdout. Feed it raw stdout
 * chunks; it invokes `onLine` for each complete, well-formed line and buffers
 * partial lines across chunk boundaries. Malformed lines are dropped.
 */
export function createLineParser(onLine: (line: SttLine) => void): (chunk: Buffer) => void {
  let buf = '';
  return (chunk: Buffer): void => {
    buf += chunk.toString('utf8');
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const raw = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (raw.length > 0) {
        const parsed = safeJsonParse<SttLine | null>(raw, null);
        if (parsed && typeof parsed.type === 'string') onLine(parsed);
      }
      nl = buf.indexOf('\n');
    }
  };
}
