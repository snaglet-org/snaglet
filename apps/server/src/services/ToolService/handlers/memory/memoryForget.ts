import { resolveMemoryOwner } from '@server/services/ToolService/ToolValidation';
import type { ToolHandler } from '@server/services/ToolService/types';
import { memoryService } from '@server/services/MemoryService';

const tool: ToolHandler = async (input, _settings, context) => {
  const owner = await resolveMemoryOwner(context, 'memory (delete)');

  const memoryId = input.memory_id as string | undefined;
  const query = input.query as string | undefined;

  if (!memoryId && !query) {
    throw new Error('At least one of memory_id or query is required');
  }

  const result = await memoryService.forget({
    ...owner,
    memoryId,
    query,
  });

  return `Forgot ${result.count} memory(ies).`;
};

export default tool;
