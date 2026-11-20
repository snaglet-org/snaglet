import type { SettingsWriteActor } from '@snaglet/db/tables/settings';
import { AGENT_GLOBAL_INSTRUCTIONS_MAX_LENGTH } from '@snaglet/shared/constants';
import { getCurrentActor } from '@server/realtime/actorContext';
import { settingsService } from '@server/services/settings';
import { agentSettings } from '@server/services/settings/categories/agent';
import type { ToolHandler, ToolHandlerContext } from '@server/services/ToolService/types';

const LIMIT = AGENT_GLOBAL_INSTRUCTIONS_MAX_LENGTH;

async function readText(): Promise<string> {
  const value: unknown = await settingsService.read(agentSettings.globalInstructions);
  return typeof value === 'string' ? value : '';
}

/**
 * Who the write is by: the calling agent, or the person when they run the
 * tool themselves (act-as borrows the agent's context only).
 */
function writeActor(context: ToolHandlerContext | undefined): SettingsWriteActor {
  if (context?.agentId && !context.bypassToolAccess) return { agentId: context.agentId };
  const actor = getCurrentActor();
  return actor?.actorKind === 'user' ? { userId: actor.actorId } : {};
}

const tool: ToolHandler = async (input, _settings, context) => {
  const op = input.op;
  if (op !== 'get' && op !== 'set') throw new Error('op must be get or set');
  const current = await readText();

  if (op === 'get') {
    return JSON.stringify({ text: current, length: current.length, limit: LIMIT });
  }

  const text = input.text;
  if (typeof text !== 'string') {
    throw new Error(
      'set needs text: the complete new instructions, which replace the old text whole ("" clears them).'
    );
  }
  if (text.length > LIMIT) {
    throw new Error(
      `Nothing changed: the text is ${text.length} characters and the limit is ${LIMIT}. Shorten it and try again.`
    );
  }
  // The setting's change event reaches Home and every open window.
  await settingsService.write(agentSettings.globalInstructions, text, writeActor(context));
  return JSON.stringify({
    saved: true,
    length: text.length,
    limit: LIMIT,
    previous: current,
    note: 'Every agent reads the new text from its next reply. To undo, call set with previous.',
  });
};

export default tool;
