import type { ToolHandler } from '@server/services/ToolService/types';
import memoryRecall from '@server/services/ToolService/handlers/memory/memoryRecall';
import memoryStore from '@server/services/ToolService/handlers/memory/memoryStore';
import memoryEdit from '@server/services/ToolService/handlers/memory/memoryEdit';
import memoryForget from '@server/services/ToolService/handlers/memory/memoryForget';

const OPS: Record<string, ToolHandler> = {
  search: memoryRecall,
  create: memoryStore,
  update: memoryEdit,
  delete: memoryForget,
};

/** memory(op): one noun tool over the owner-scoped memory store. */
const tool: ToolHandler = async (input, settings, context) => {
  const handler = typeof input.op === 'string' ? OPS[input.op] : undefined;
  if (!handler) {
    throw new Error(`op is required and must be one of ${Object.keys(OPS).join(' | ')}.`);
  }
  return handler(input, settings, context);
};

export default tool;
