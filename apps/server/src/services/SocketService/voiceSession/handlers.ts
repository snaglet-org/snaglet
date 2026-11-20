/**
 * voiceSession/handlers — WS registration for the voice protocol.
 *
 * Mirrors the existing handler-registration pattern (chatSecondaryHandlers.ts):
 * one register function that binds every voice:* message to VoiceSessionService,
 * plus a disconnect hook so a dropped client releases its floor + STT. Wired from
 * SocketService/index.ts alongside the other register* calls.
 */

import { wsService } from '@server/services/WebSocketService';
import { voiceSessionService } from './VoiceSessionService';
import { initTtsPipeline } from './ttsPipeline';
import { initRunPhaseTracker } from './runPhaseTracker';
import type {
  VoiceSessionStartPayload,
  VoiceAudioChunkPayload,
  VoiceUtteranceEndPayload,
  VoicePlaybackDonePayload,
  VoiceBargeInPayload,
  VoiceSessionStopPayload,
  VoiceTargetsPayload,
  VoiceAttachmentsPayload,
} from './types';

export function registerVoiceHandlers(): void {
  // Subscribe the outbound pipeline + run-phase tracker to the utterance stream.
  initTtsPipeline();
  initRunPhaseTracker();

  wsService.registerHandler<VoiceSessionStartPayload>('voice:session:start', (payload, meta) =>
    voiceSessionService.start(payload, meta.clientId)
  );

  wsService.registerHandler<VoiceAudioChunkPayload>('voice:audio:chunk', (payload, meta) =>
    voiceSessionService.audioChunk(payload, meta.clientId)
  );

  wsService.registerHandler<VoiceUtteranceEndPayload>('voice:utterance:end', (payload, meta) =>
    voiceSessionService.utteranceEnd(payload, meta.clientId)
  );

  wsService.registerHandler<VoicePlaybackDonePayload>('voice:playback:done', (payload, meta) =>
    voiceSessionService.playbackDone(payload, meta.clientId)
  );

  wsService.registerHandler<VoiceBargeInPayload>('voice:bargein', (payload, meta) =>
    voiceSessionService.bargeIn(payload, meta.clientId)
  );

  wsService.registerHandler<VoiceSessionStopPayload>('voice:session:stop', (payload, meta) =>
    voiceSessionService.stop(payload, meta.clientId)
  );

  // Live pill re-targeting mid-session.
  wsService.registerHandler<VoiceTargetsPayload>('voice:targets:set', (payload, meta) =>
    voiceSessionService.setTargets(payload, meta.clientId)
  );

  // Live sync of the composer's image attachments (appended to the dispatched
  // message as <image id/> markers, same as the manual composer send).
  wsService.registerHandler<VoiceAttachmentsPayload>('voice:attachments:set', (payload, meta) =>
    voiceSessionService.setAttachments(payload, meta.clientId)
  );

  // A dropped client's voice session dies → floor auto-release + STT close.
  wsService.onDisconnect((clientId) => voiceSessionService.handleDisconnect(clientId));
}
