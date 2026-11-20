/**
 * voiceIdNamespace — the voice-id namespace scheme that lets one `agents.voice`
 * string address either TTS engine.
 *
 * A voice id is dispatched by prefix:
 *   `apple:<AVSpeechSynthesisVoiceIdentifier>`  → the Apple on-device engine
 *   `piper:<voiceId>`                            → the local piper engine
 *   `<voiceId>` (no prefix)                      → the local piper engine
 *
 * BACK-COMPAT is the whole point of the bare case: every `agents.voice` value
 * stored before hybrid TTS is a BARE piper id (e.g. `en_US-amy-medium`), and
 * `DEFAULT_VOICE_ID` is itself a bare piper id. Treating bare === piper means
 * zero migration and zero regression — existing agents keep their exact voice
 * (a bare id the catalog no longer ships still routes to piper, which speaks
 * it in the default voice: see `resolveVoice`),
 * and an install with no Apple voices downloaded behaves exactly as before.
 *
 * The capabilities endpoint therefore emits piper ids BARE (not `piper:`-
 * prefixed) so the picker keeps storing the same strings it always has; only
 * Apple voices carry a namespace. The `piper:` prefix is still accepted for
 * completeness/symmetry.
 */

type VoiceEngineName = 'apple' | 'piper';

const APPLE_VOICE_PREFIX = 'apple:';
const PIPER_VOICE_PREFIX = 'piper:';

export interface ParsedVoiceId {
  readonly engine: VoiceEngineName;
  /** The engine-native id with any namespace prefix stripped. */
  readonly nativeId: string;
}

/** Dispatch a (possibly namespaced) voice id to its engine + native id. */
export function parseVoiceId(voiceId: string): ParsedVoiceId {
  const id = voiceId.trim();
  if (id.startsWith(APPLE_VOICE_PREFIX)) {
    return { engine: 'apple', nativeId: id.slice(APPLE_VOICE_PREFIX.length) };
  }
  if (id.startsWith(PIPER_VOICE_PREFIX)) {
    return { engine: 'piper', nativeId: id.slice(PIPER_VOICE_PREFIX.length) };
  }
  // Bare / unprefixed → piper (back-compat with existing agents.voice values).
  return { engine: 'piper', nativeId: id };
}

/** Namespace an Apple voice identifier for storage/dispatch. */
export function toAppleVoiceId(identifier: string): string {
  return `${APPLE_VOICE_PREFIX}${identifier}`;
}
