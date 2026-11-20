import { generateId } from '@snaglet/shared/utils';
import { Agents } from '@snaglet/db/tables/agents';
import { Images } from '@snaglet/db/tables/images';
import { defaultCursorSpec, type CursorSpec } from '@snaglet/shared/cursor';
import { resolveAgentCursor } from '@snaglet/shared/constants/agentCursor';
import type { ToolHandler, ToolHandlerRichResult } from '@server/services/ToolService/types';
import { sniffImageMime } from '@server/services/ToolService/lib/sniffImageMime';
import { resolveAgentImageContainer } from '@server/services/ToolService/lib/resolveAgentImageContainer';
import { emitTreeNodeCreated, snapshotFromImage } from '@server/realtime/surfaces/tree';
import { getBrowserController } from '@server/services/BrowserController';

const tool: ToolHandler = async (
  input,
  _settings,
  context
): Promise<string | ToolHandlerRichResult> => {
  const agentId = context?.agentId;
  if (!agentId) throw new Error('browser: requires an agent context');
  const agent = (await Agents.findById(agentId).catch(() => null)) as {
    name?: string | null;
    cursorFlower?: string | null;
    cursorColor?: string | null;
    cursorSpec?: CursorSpec | null;
  } | null;
  const { flower, color } = resolveAgentCursor(agentId, agent?.cursorFlower, agent?.cursorColor);
  const result = await getBrowserController().run(
    {
      id: agentId,
      name: agent?.name ?? 'An agent',
      flower,
      color,
      cursorSpec: agent?.cursorSpec ?? defaultCursorSpec(agentId),
      cwd: context?.cwd,
    },
    input as Record<string, unknown>,
    { signal: context?.signal }
  );
  const { screenshot, ...rest } = result;
  if (!screenshot) return JSON.stringify(rest);
  if (screenshot.byteLength === 0) return JSON.stringify({ ok: false, error: 'screenshot failed' });
  const imageId = generateId('image');
  const created = await Images.createImage({
    id: imageId,
    name: `browser-${imageId.slice(0, 8)}.png`,
    containerId: await resolveAgentImageContainer(context?.threadId),
    mimeType: sniffImageMime(screenshot) ?? 'image/png',
    data: screenshot,
    sizeBytes: screenshot.byteLength,
    tags: ['tool-capture'],
  });
  emitTreeNodeCreated(snapshotFromImage(created));
  return {
    output: `captured${rest.url ? ` ${String(rest.url)}` : ''}, image id ${imageId}`,
    rawContent: { inlineImageIds: [imageId], note: `browser capture saved as ${imageId}` },
  };
};

export default tool;
