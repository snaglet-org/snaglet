import type { ToolHandler } from '@server/services/ToolService/types';
import workspaceTree from '@server/services/ToolService/handlers/trivial/workspaceTree';
import workspaceProjectTree from '@server/services/ToolService/handlers/trivial/workspaceProjectTree';

const tool: ToolHandler = async (input, settings, context) =>
  input.scope === 'current_project'
    ? workspaceProjectTree(input, settings, context)
    : workspaceTree(input, settings, context);

export default tool;
