/**
 * voiceSession/voiceDispatch — compose the outgoing message (pill/default
 * mentions or the barge-in routing mention + heard-up-to) and send it through
 * the exact typed-user-message path, as free functions over a VoiceSessionState.
 *
 * voice:final rides the persist callback (early), not after the whole agent run
 * resolves.
 */

import { getErrorMessage } from '@snaglet/shared/utils';
import { agentService } from '@server/services/AgentService';
import { buildImageMarkers } from '@server/services/imageMarkers';
import { LogsService } from '@server/services/LogsService';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { processChatSend } from '@server/services/SocketService/handlers/chatHandlers';
import { resolveHeardUpToLine } from './bargeIn';
import { resolveDefaultTargets } from './resolveAgentVoice';
import { toThread, voiceError } from './voiceTransport';
import { BARGE_IN_TEARDOWN_TIMEOUT_MS } from './constants';
import type { VoiceSessionState, BargeInTarget } from './types';

/** Compose the outgoing message (mentions + heard-up-to) and send it. */
export async function sendTranscript(
  state: VoiceSessionState,
  clientId: string,
  transcript: string,
  bargeIn: BargeInTarget | null,
  utteranceSeq: number
): Promise<void> {
  let text = transcript;
  // Barge-in "heard up to" marker, delivered via the persisted-injection
  // channel (not concatenated into content) so the user's chat bubble stays
  // clean — just their words. null except on the barge-in path.
  let heardUpToInjection: string | null = null;
  if (bargeIn) {
    // Barge-in: route only to the interrupted agent, no pill mentions. Content
    // is the clean transcript plus the interrupted agent's routing @mention;
    // the heard-up-to machinery rides `persistedInjection` (below) so the model
    // still gets it adjacent to the message without it landing in the bubble.
    heardUpToInjection = await resolveHeardUpToLine(bargeIn.heardUpTo);
    const mention = await mentionFor(bargeIn.agentId);
    text = mention ? `${transcript} ${mention}` : transcript;

    // Mid-speech barge-in aborted the interrupted run; wait for its run-lock to
    // release before sending so this redispatches as a fresh run rather than
    // enqueueing as a mid-run injection against the run we just aborted.
    if (bargeIn.awaitTeardown) {
      await activeRunTracker.waitForThreadRelease(state.threadId, BARGE_IN_TEARDOWN_TIMEOUT_MS);
    }
  } else {
    // Normal: append @Name for each selected pill (or the default target).
    let targets = state.targetAgentIds;
    if (targets.length === 0) {
      targets = await resolveDefaultTargets(state.threadId, state.participantAgentIds);
    }
    const mentions = (await Promise.all(targets.map((id) => mentionFor(id)))).filter(
      (m): m is string => Boolean(m)
    );
    if (mentions.length > 0) text = `${transcript} ${mentions.join(' ')}`;
  }

  // Attachments: append the composer's attached image ids as `<image id="…"/>`
  // markers — the exact format the manual composer send appends — so a
  // voice-dictated message carries the user's images too. Consumed here (cleared
  // on send) so the same images aren't re-attached to the next utterance, matching
  // the manual send which clears its attachments on submit. The voice:final echo
  // below still carries the clean transcript, so the composer + chat bubble stay
  // free of the raw markers while the persisted content (and the model) get them.
  if (state.attachmentImageIds.length > 0) {
    const markers = buildImageMarkers(state.attachmentImageIds);
    text = text.length > 0 ? `${text} ${markers}` : markers;
    state.attachmentImageIds = [];
  }

  // voice:final carries the raw transcript (what the user said) + the persisted
  // id — the appended @mentions are an internal routing detail, not display text.
  // Emit it at persist time (the onUserMessagePersisted callback), not after the
  // whole agent run resolves: processChatSend also awaits dispatch (seconds),
  // while persist lands within ~200 ms. Guarded so it fires exactly once.
  let emittedFinal = false;
  const emitFinal = (messageId: string | null): void => {
    if (emittedFinal) return;
    emittedFinal = true;
    toThread(state.threadId, 'voice:final', { text: transcript, messageId, utteranceSeq });
  };

  // Reuse the exact typed-user-message path; stamp source='voice'. voice:final
  // rides the persist callback (early).
  await processChatSend(
    {
      sessionId: state.chatSessionId,
      message: text,
      voiceOriginated: true,
      // Barge-in only: rides the persisted-injection channel (clean bubble +
      // marker to the model on both replay and live mid-tool injection paths).
      ...(heardUpToInjection ? { persistedInjection: heardUpToInjection } : {}),
    },
    {
      clientId,
      onUserMessagePersisted: (id) => emitFinal(id),
    }
  ).catch((err) => {
    LogsService.error('voice send failed', err, { threadId: state.threadId });
    voiceError(state.threadId, `Voice send failed: ${getErrorMessage(err)}`, true);
  });

  // Fallback: if persist never fired (e.g. the send failed before persisting),
  // still emit voice:final so the composer clears — no id to carry.
  emitFinal(null);
}

async function mentionFor(agentId: string): Promise<string | null> {
  try {
    const agent = await agentService.get(agentId);
    if (!agent?.name) return null;
    return `@${agent.name}`;
  } catch {
    return null;
  }
}
