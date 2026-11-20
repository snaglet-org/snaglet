import { resolveMemoryOwner } from '@server/services/ToolService/ToolValidation';
import type { ToolHandler } from '@server/services/ToolService/types';
import { memoryService } from '@server/services/MemoryService';

const tool: ToolHandler = async (input, _settings, context) => {
  const query = String(input.query ?? '');
  if (!query) throw new Error('query is required');
  const owner = await resolveMemoryOwner(context, 'memory (search)');

  const limit = Number(input.limit ?? 5);

  // Scoped to THIS owner only (agent XOR member) — no cross-owner leakage.
  const results = await memoryService.recall({
    ...owner,
    threadId: context?.threadId,
    query,
    limit,
  });

  if (results.length === 0) return 'No memories found matching your query.';

  const formatted = results
    .map((m, i) => `${i + 1}. [${m.key}] (score: ${m.combinedScore.toFixed(3)})\n   ${m.content}`)
    .join('\n\n');
  return `Found ${results.length} memory(ies):\n\n${formatted}`;
};

export default tool;
