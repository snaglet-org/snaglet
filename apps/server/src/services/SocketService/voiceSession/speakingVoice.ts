/**
 * speakingVoice — the voice a saved voice id is spoken with, given the voices
 * installed on this device. The saved id itself is never changed.
 */

import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { installedVoiceIds } from '@server/services/voice/installedVoices';
import { resolveVoice } from '@server/services/voice/voiceModelManifest';
import { parseVoiceId } from './voiceIdNamespace';

/**
 * Apple voices pass through: they are not Snaglet downloads. A piper id the
 * catalog does not ship means the default voice (`resolveVoice`). When that
 * voice is not installed, the first installed voice speaks instead. With no
 * voice installed the resolved id is returned as is, and synthesis fails the
 * way it does whenever local text-to-speech is missing.
 */
export async function speakingVoiceId(voiceId: string): Promise<string> {
  const { engine, nativeId } = parseVoiceId(voiceId);
  if (engine !== 'piper') return voiceId;
  const wanted = resolveVoice(nativeId).id;
  try {
    const installed = await installedVoiceIds();
    if (installed.includes(wanted)) return wanted;
    return installed[0] ?? wanted;
  } catch (err) {
    logger.warn(
      `[voice] installed-voice lookup failed, speaking ${wanted}: ${getErrorMessage(err)}`
    );
    return wanted;
  }
}
