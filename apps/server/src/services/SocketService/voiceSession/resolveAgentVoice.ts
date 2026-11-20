/**
 * resolveAgentVoice — per-agent TTS voice id + default speaking-target rules.
 *
 * Voice storage: `agents.voice` is a nullable text column
 * surfaced on SnagletAgent.voice. The agent-detail picker writes it; here we read
 * it, falling back to the deterministic DEFAULT_VOICE_ID when null — so an
 * unconfigured agent always sounds the same, never random.
 */

import { agentService } from '@server/services/AgentService';
import { Messages } from '@snaglet/db/tables/messages';
import { getErrorMessage } from '@snaglet/shared/utils';
import { LogsService } from '@server/services/LogsService';
import { DEFAULT_VOICE_ID } from './constants';
import { speakingVoiceId } from './speakingVoice';

/**
 * Resolve the TTS voice id an agent speaks with. Falls back to DEFAULT_VOICE_ID
 * when the agent has no voice configured. Never throws — a lookup failure
 * degrades to the default voice.
 *
 * A piper voice that is not installed on this device speaks as the first
 * installed voice instead (`speakingVoiceId`); the agent keeps its saved voice,
 * so reinstalling that voice brings it back. Apple ids (`apple:<AVid>`) pass
 * through; the engine router (engineAdapter.buildTtsRouter) dispatches on the
 * namespace, and a bare id routes to piper.
 */
export async function resolveAgentVoiceId(agentId: string): Promise<string> {
  let saved = DEFAULT_VOICE_ID;
  try {
    const agent = await agentService.get(agentId);
    const configured = agent?.voice;
    if (typeof configured === 'string' && configured.trim().length > 0) {
      saved = configured.trim();
    }
  } catch (err) {
    LogsService.warn('voice id resolution failed — using default', {
      agentId,
      error: getErrorMessage(err),
    });
  }
  return speakingVoiceId(saved);
}

/**
 * Default speaking targets when the user set no pills:
 *   - solo thread (one participant) → that one agent,
 *   - group → the last agent who spoke (latest assistant message),
 *   - group with no prior speaker → [] (no mention appended; nothing to target
 *     yet — the user should pick a pill or @mention).
 */
export async function resolveDefaultTargets(
  threadId: string,
  participantAgentIds: readonly string[]
): Promise<string[]> {
  if (participantAgentIds.length === 1) return [participantAgentIds[0]!];
  try {
    const recent = await Messages.listRecentByThreadId(threadId, 50);
    for (let i = recent.length - 1; i >= 0; i--) {
      const row = recent[i]!;
      if (row.role === 'assistant' && row.agentId) return [row.agentId];
    }
  } catch (err) {
    LogsService.warn('default-target resolution failed', {
      threadId,
      error: getErrorMessage(err),
    });
  }
  return [];
}
