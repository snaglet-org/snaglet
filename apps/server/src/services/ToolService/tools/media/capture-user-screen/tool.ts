import { Messages } from '@snaglet/db/tables/messages';
import { Models } from '@snaglet/db/tables/models';
import type { ToolHandler, ToolHandlerContext } from '@server/services/ToolService/types';
import { visionThreadService } from '@server/services/vision/VisionThreadService';

async function requireVisionTurn(context: ToolHandlerContext | undefined): Promise<{
  threadId: string;
  agentId: string;
  turnId: string;
  ownerUserId: string;
}> {
  if (!context?.threadId || !context.agentId || !context.triggerMessageId) {
    throw new Error('capture_user_screen: requires an active agent turn in a chat thread.');
  }
  if (!context.runtime) {
    throw new Error('capture_user_screen: model runtime is unavailable.');
  }
  const model = await Models.findByProviderAndModelId(
    context.runtime.provider,
    context.runtime.modelId
  ).catch(() => null);
  if (model?.supportsVision !== true) {
    throw new Error('capture_user_screen: the active model cannot inspect images.');
  }
  const trigger = await Messages.findById(context.triggerMessageId);
  if (!trigger?.userId || trigger.threadId !== context.threadId) {
    throw new Error('Vision capture requires a user-authored trigger message in this thread.');
  }
  return {
    threadId: context.threadId,
    agentId: context.agentId,
    turnId: context.triggerMessageId,
    ownerUserId: trigger.userId,
  };
}

const tool: ToolHandler = async (_input, _settings, context) => {
  const turn = await requireVisionTurn(context);
  const frame = await visionThreadService.captureOnDemand({
    ...turn,
    source: 'screen',

    signal: context?.signal,
  });
  return {
    output: JSON.stringify({
      success: true,
      temporary_frame_id: frame.frameId,
      source: frame.source,
      captured_at: frame.capturedAt,
      byte_length: frame.byteLength,
      reused_this_turn: frame.reused,
      retention: 'temporary_until_turn_end',
    }),
    rawContent: {
      ephemeralInlineImages: [
        { id: frame.frameId, mediaType: frame.mediaType, data: frame.base64 },
      ],
    },
  };
};

export default tool;
