import type { ToolHandler } from '@server/services/ToolService/types';

const tool: ToolHandler = async () =>
  'Error: action is a dispatch gateway and cannot be executed as a regular subtool.';

export default tool;
