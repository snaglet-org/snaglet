import type { ToolHandler } from '@server/services/ToolService/types';
import localContext from '@server/services/ToolService/handlers/trivial/localContext';
import workspaceOrient from '@server/services/ToolService/handlers/trivial/workspaceOrient';

const tool: ToolHandler = async (input, settings, context) =>
  input.mode === 'local'
    ? localContext(input, settings, context)
    : workspaceOrient(input, settings, context);

export default tool;
