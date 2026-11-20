/**
 * appleTtsProtocol — the wire contract with the `snaglet-apple-tts` Swift sidecar.
 *
 * Shared by {@link AppleTtsEngine} (the real client) and the jest fake daemon,
 * so both speak the exact same bytes. See native/apple-tts/README.md for the
 * canonical spec. In short:
 *
 *   host → daemon (stdin): length-prefixed JSON request frames
 *     [4 byte big-endian uint32 length][length bytes UTF-8 JSON]
 *       {"cmd":"synthesize","id":N,"text":..,"voiceId":..}
 *       {"cmd":"list-voices","id":N}
 *       {"cmd":"cancel","id":N}
 *   daemon → host (stdout): length-prefixed TAGGED frames
 *     [1 byte tag][4 byte big-endian uint32 length][length bytes payload]
 *       0x01 AUDIO  = [4 byte BE id][raw little-endian FLOAT32 mono @ 22050]
 *       0x02 END    = [4 byte BE id]
 *       0x03 JSON   = one UTF-8 JSON object (ready | voices | error)
 *
 * Unlike apple-stt (raw pcm frames IN, JSON OUT), apple-tts is the mirror image:
 * structured JSON requests IN, binary audio frames OUT.
 */

import { safeJsonParse } from '@snaglet/shared/utils';

/** stdout frame tags (daemon → host). */
const TTS_TAG = {
  AUDIO: 0x01,
  END: 0x02,
  JSON: 0x03,
} as const;

/** A voice as reported by the daemon's list-voices reply. */
export interface AppleVoiceInfo {
  readonly identifier: string;
  readonly name: string;
  readonly quality: 'default' | 'enhanced' | 'premium';
  readonly lang: string;
}

/** One JSON line the daemon emits (tag 0x03). */
export type TtsJson =
  | { readonly type: 'ready' }
  | { readonly type: 'voices'; readonly id: number; readonly voices: AppleVoiceInfo[] }
  | { readonly type: 'error'; readonly id?: number; readonly message?: string };

/** A decoded stdout frame. */
export type TtsFrame =
  | { readonly kind: 'audio'; readonly id: number; readonly float32: Float32Array }
  | { readonly kind: 'end'; readonly id: number }
  | { readonly kind: 'json'; readonly json: TtsJson };

// --- host → daemon request encoders -----------------------------------------

/** Length-prefix a UTF-8 JSON request frame (`[4 BE len][json]`). */
function encodeRequest(obj: Record<string, unknown>): Buffer {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

export function encodeSynthesize(id: number, text: string, voiceId: string): Buffer {
  return encodeRequest({ cmd: 'synthesize', id, text, voiceId });
}

export function encodeListVoices(id: number): Buffer {
  return encodeRequest({ cmd: 'list-voices', id });
}

export function encodeCancel(id: number): Buffer {
  return encodeRequest({ cmd: 'cancel', id });
}

// --- daemon → host frame parser ---------------------------------------------

/**
 * A tagged-frame parser for the daemon's stdout. Feed it raw stdout chunks; it
 * invokes `onFrame` for each complete frame and buffers partial frames across
 * chunk boundaries. Audio payloads decode the little-endian float32 body (via a
 * DataView, so an unaligned pipe offset never trips a Float32Array view).
 */
export function createTtsFrameParser(onFrame: (frame: TtsFrame) => void): (chunk: Buffer) => void {
  let buf: Buffer = Buffer.alloc(0);
  return (chunk: Buffer): void => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    while (buf.length >= 5) {
      const tag = buf[0]!;
      const len = buf.readUInt32BE(1);
      if (buf.length < 5 + len) break;
      const payload = buf.subarray(5, 5 + len);
      buf = buf.subarray(5 + len);
      dispatch(tag, payload, onFrame);
    }
  };
}

function dispatch(tag: number, payload: Buffer, onFrame: (frame: TtsFrame) => void): void {
  if (tag === TTS_TAG.AUDIO) {
    if (payload.length < 4) return;
    const id = payload.readUInt32BE(0);
    const body = payload.subarray(4);
    const count = Math.floor(body.length / 4);
    const float32 = new Float32Array(count);
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    for (let i = 0; i < count; i++) float32[i] = view.getFloat32(i * 4, true);
    onFrame({ kind: 'audio', id, float32 });
    return;
  }
  if (tag === TTS_TAG.END) {
    if (payload.length < 4) return;
    onFrame({ kind: 'end', id: payload.readUInt32BE(0) });
    return;
  }
  if (tag === TTS_TAG.JSON) {
    const parsed = safeJsonParse<TtsJson | null>(payload.toString('utf8'), null);
    if (parsed && typeof (parsed as { type?: unknown }).type === 'string') {
      onFrame({ kind: 'json', json: parsed });
    }
  }
}
