/**
 * workspaceInstructionsBlock — the workspace owner's instructions for all
 * agents, written on Home (`agent.global_instructions`).
 *
 * Workspace segment: the same bytes for every agent in every thread, so it
 * sits after the agent-level core and before the thread segment (skill
 * catalog, then the thread's own instructions). That order is cache layout,
 * not authority: the thread instructions' frame makes them subordinate to
 * platform and agent instructions (the hierarchy is in composeSystemPrompt's
 * header). The owner saves this text on Home (/api/settings); an agent can
 * replace it only with `workspace_instructions` set, which asks a person
 * first. Saving new text is a rare, accepted cache bust.
 *
 * The owner's text is rendered whole, never summarized or truncated; the
 * setting's length cap is enforced when it is saved. Skipped when the
 * setting is empty or whitespace.
 */

import { getErrorMessage } from '@snaglet/shared/utils';
import { LogsService } from '@server/services/LogsService';
import { settingsService } from '@server/services/settings';
import { agentSettings } from '@server/services/settings/categories/agent';
import { neutralizeDelimitedContent } from '@server/services/ToolService/lib/untrustedContent';
import type { BlockBuilder } from '../types';

export const WORKSPACE_INSTRUCTIONS_OPEN =
  '[Instructions for all agents — written by the workspace owner on Home.]';
export const WORKSPACE_INSTRUCTIONS_CLOSE = '[/Instructions for all agents]';

async function readInstructions(): Promise<string> {
  try {
    const value: unknown = await settingsService.read(agentSettings.globalInstructions);
    return typeof value === 'string' ? value.trim() : '';
  } catch (err) {
    // A turn still runs without the block; the warning says why it is missing.
    LogsService.warn('workspaceInstructionsBlock: setting unavailable', {
      error: getErrorMessage(err),
    });
    return '';
  }
}

export const workspaceInstructionsBlock: BlockBuilder = async () => {
  const text = await readInstructions();
  if (!text) return null;
  return {
    type: 'text',
    text: [
      WORKSPACE_INSTRUCTIONS_OPEN,
      neutralizeDelimitedContent(text, [WORKSPACE_INSTRUCTIONS_OPEN, WORKSPACE_INSTRUCTIONS_CLOSE]),
      WORKSPACE_INSTRUCTIONS_CLOSE,
    ].join('\n'),
  };
};
