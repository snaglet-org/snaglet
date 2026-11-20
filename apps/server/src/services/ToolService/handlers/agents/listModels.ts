import type { ToolHandler } from '@server/services/ToolService/types';
import getProviders from '@server/services/ToolService/handlers/agents/getProviders';
import getProviderModels from '@server/services/ToolService/handlers/agents/getProviderModels';

const tool: ToolHandler = async (input, settings, context) =>
  input.operation === 'models'
    ? getProviderModels(input, settings, context)
    : getProviders(input, settings, context);

export default tool;
