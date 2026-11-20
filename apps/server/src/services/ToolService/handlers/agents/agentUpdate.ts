import type { ToolHandler } from '@server/services/ToolService/types';
import updateAgent from '@server/services/ToolService/handlers/agents/updateAgent';
import updateIdentity from '@server/services/ToolService/handlers/agents/updateIdentity';
import { hasSkillChange } from './agentSkills';

const tool: ToolHandler = async (input, settings, context) => {
  if (input.scope === 'self') {
    // The self route only writes identity fields; refuse skill changes there
    // instead of silently dropping them.
    if (hasSkillChange(input)) {
      return JSON.stringify({
        success: false,
        error: 'Skill changes need scope:"agent" with an agent_id.',
      });
    }
    return updateIdentity(input, settings, context);
  }
  return updateAgent(input, settings, context);
};

export default tool;
