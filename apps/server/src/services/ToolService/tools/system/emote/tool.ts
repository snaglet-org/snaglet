import { EMOTION_IDS, type EmotionId } from '@snaglet/shared/cursor/emotions';
import type { ToolHandler } from '@server/services/ToolService/types';
import { AVATAR_EMOTES, type AvatarEmote } from '@snaglet/shared/constants/agentCursor';
import { emitAvatarEmote } from '../computer/tool';
const tool: ToolHandler = async (input, _settings, context) => {
  if (!context?.agentId) throw new Error('emote requires a calling agent');
  if (input.animation === undefined && input.emotion === undefined)
    throw new Error('Choose an emotion, an animation, or both');
  if (
    input.animation !== undefined &&
    !(AVATAR_EMOTES as readonly unknown[]).includes(input.animation)
  )
    throw new Error('Choose spin, hyper, laugh, cry, celebrate or angry');
  if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 200))
    throw new Error('reason must be at most 200 characters');
  if (input.emotion !== undefined && !(EMOTION_IDS as readonly unknown[]).includes(input.emotion))
    throw new Error('Unknown emotion');
  const emitted = await emitAvatarEmote(
    context.agentId,
    input.animation as AvatarEmote | undefined,
    input.reason as string | undefined,
    input.emotion as EmotionId | undefined
  );
  return JSON.stringify({
    ok: emitted,
    animation: input.animation,
    emotion: input.emotion,
    ...(emitted ? {} : { error: 'Place your avatar with computer op:point first' }),
  });
};
export default tool;
