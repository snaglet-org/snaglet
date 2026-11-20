import type { ToolHandler } from '@server/services/ToolService/types';
import filesystemResolvePath from '@server/services/ToolService/handlers/trivial/filesystemResolvePath';
import workspaceResolvePath from '@server/services/ToolService/handlers/trivial/workspaceResolvePath';

const tool: ToolHandler = async (input, settings, context) =>
  input.domain === 'filesystem'
    ? filesystemResolvePath(input, settings, context)
    : workspaceResolvePath(input, settings, context);

export default tool;
