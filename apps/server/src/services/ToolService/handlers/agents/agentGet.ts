import type { ToolHandler } from '@server/services/ToolService/types';
import getAgent from '@server/services/ToolService/handlers/trivial/getAgent';
import selfInspect from '@server/services/ToolService/handlers/trivial/selfInspect';

const tool: ToolHandler = async (input, settings, context) =>
  input.view === 'runtime_self'
    ? selfInspect(input, settings, context)
    : getAgent(input, settings, context);

export default tool;
