import { resolveMemoryOwner } from '@server/services/ToolService/ToolValidation';
import type { ToolHandler } from '@server/services/ToolService/types';
import { memoryService } from '@server/services/MemoryService';
import { asTrimmedString, normalizeWhitespace } from '@snaglet/shared/utils';

const AUTO_KEY_MAX_WORDS = 8;
const AUTO_KEY_MAX_LENGTH = 64;

function deriveMemoryKey(content: string): string {
  const normalized = normalizeWhitespace(content);
  const slug = normalized
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['"`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const limited = slug
    .split('-')
    .filter(Boolean)
    .slice(0, AUTO_KEY_MAX_WORDS)
    .join('-')
    .slice(0, AUTO_KEY_MAX_LENGTH)
    .replace(/-+$/g, '');

  if (limited) return limited;

  const fallbackSuffix = Buffer.from(normalized).toString('hex').slice(0, 12) || 'note';
  return `memory-${fallbackSuffix}`;
}

const tool: ToolHandler = async (input, _settings, context) => {
  const content = typeof input.content === 'string' ? input.content : String(input.content ?? '');
  if (!content.trim()) throw new Error('content is required');
  const owner = await resolveMemoryOwner(context, 'memory (create)');

  const key = asTrimmedString(input.key) ?? deriveMemoryKey(content);

  const result = await memoryService.store({
    ...owner,
    threadId: context?.threadId,
    key,
    content,
  });

  if (result.isDuplicate) {
    return `Memory updated (near-duplicate found): '${key}' (id: ${result.id})`;
  }
  return `Memory stored: '${key}' (id: ${result.id})`;
};

export default tool;
