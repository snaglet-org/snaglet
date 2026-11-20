/**
 * installedVoices — which catalog piper voices are installed on this device.
 *
 * Read from disk on every call, never from a stored list: a voice is installed
 * when its model and tokens files are present (resolved the way the engine
 * loads them, so a verified shared copy counts) and it was not uninstalled
 * (an uninstall marks `tts:<voiceId>` disabled in the local-model preferences).
 */

import { access } from 'fs/promises';
import { getDisabledLocalModels } from '../localModels/localModelPreferences';
import { VOICE_CATALOG, voiceModelPaths } from './voiceModelManifest';

/** A piper voice's id among the local models (Storage, local-model preferences). */
export function voiceModelId(voiceId: string): string {
  return `tts:${voiceId}`;
}

/** BCP-47 language tag of a piper voice id (`en_GB-alan-medium` → `en-GB`). */
export function voiceLang(voiceId: string): string {
  return (voiceId.split('-', 1)[0] ?? voiceId).replace('_', '-');
}

/** Quality tier of a piper voice id, its last segment (`en_US-amy-medium` → `medium`). */
export function voiceQuality(voiceId: string): string {
  return voiceId.slice(voiceId.lastIndexOf('-') + 1);
}

function present(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false
  );
}

/** Catalog voices installed on this device, in catalog order. */
export async function installedVoiceIds(): Promise<string[]> {
  const disabled = await getDisabledLocalModels();
  const installed = await Promise.all(
    VOICE_CATALOG.map(async (voice) => {
      if (disabled.has(voiceModelId(voice.id))) return false;
      const paths = voiceModelPaths(voice.id);
      const [model, tokens] = await Promise.all([present(paths.model), present(paths.tokens)]);
      return model && tokens;
    })
  );
  return VOICE_CATALOG.filter((_, i) => installed[i]).map((voice) => voice.id);
}
