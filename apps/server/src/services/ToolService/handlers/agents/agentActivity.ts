import type { ToolHandler } from '@server/services/ToolService/types';
import agentRecentActivity from '@server/services/ToolService/handlers/agents/agentRecentActivity';
import myActivity from '@server/services/ToolService/handlers/agents/myActivity';
import runHistory from '@server/services/ToolService/handlers/agents/runHistory';

const tool: ToolHandler = async (input, settings, context) => {
  if (input.view === 'self_history') return runHistory(input, settings, context);
  if (input.view === 'self_recent') return myActivity(input, settings, context);
  return agentRecentActivity(input, settings, context);
};

export default tool;
