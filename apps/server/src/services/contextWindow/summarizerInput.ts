/**
 * Summarizer input — what a summary model reads when it condenses messages.
 *
 * The older digest (`buildPayloadDigest`) cut every message to 150 characters, assistant text
 * before a tool call to 80 and a tool input to 60, so the summarizer never saw most of a reply
 * and a summary could reverse a decision. This keeps the messages whole and condenses only the
 * tool calls, by what they are worth to a summary:
 *
 *   - writes   : the call's target and the ids it returned stay whole; bulky inputs (a doc body)
 *                shrink to a length.
 *   - errors   : the error text stays whole.
 *   - reads    : what was looked at plus a short head of the result.
 *   - bulky read output (a file, a schema, a page): dropped to the path, url or id that
 *                re-fetches it.
 *
 * A summary message is never input: a prior summary is carried forward verbatim by whoever owns
 * it, never summarized again. The caller budgets the result against the summarizer's window.
 */

import type { ProviderMessage } from '@server/services/ProviderChatService';
import { classifyToolCall } from '@server/services/SocketService/handlers/chatPhases/toolCallTargeting';
import { resolveEffectiveToolName } from '@server/services/ToolService/toolResultFormat';

/** Headers of the summary messages Snaglet inserts into a payload; none may reach a summarizer. */
const SUMMARY_MESSAGE_PREFIXES = [
  '[Historical context summary',
  '[Earlier in this run, summarized]',
] as const;

/** Most of an error or a write's returned ids kept whole. */
const WHOLE_RESULT_MAX_CHARS = 4_000;
/** A read result at or under this is kept whole. */
const READ_WHOLE_MAX_CHARS = 300;
/** A read result over this is dropped to a reference instead of a head. */
const READ_BULKY_MIN_CHARS = 2_000;
/** Longest a tool input value is shown before it becomes a length. */
const INPUT_VALUE_MAX_CHARS = 200;
function isSummaryMessage(message: ProviderMessage): boolean {
  if (message.role !== 'user' || typeof message.content !== 'string') return false;
  const text = message.content.trimStart();
  return SUMMARY_MESSAGE_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      block && typeof block === 'object' && 'text' in block && typeof block.text === 'string'
        ? block.text
        : ''
    )
    .filter(Boolean)
    .join('\n');
}

function showValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return 'undefined';
  return text.length > INPUT_VALUE_MAX_CHARS
    ? `(${text.length} chars)`
    : typeof value === 'string'
      ? JSON.stringify(value)
      : text;
}

/** `op=update id="doc-…" content=(5000 chars)`: every key, a long value reduced to its length. */
function showInput(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return input === undefined ? '' : showValue(input);
  }
  return Object.entries(input as Record<string, unknown>)
    .map(([key, value]) => `${key}=${showValue(value)}`)
    .join(' ');
}

/** What re-fetches a read's output: its path, url or id. */
function refetchReference(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  for (const key of ['path', 'url', 'id', 'doc_id', 'table', 'query']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function describeResult(args: {
  text: string;
  isError: boolean;
  role: 'read' | 'mutation' | 'other';
  input: unknown;
}): string {
  const { text, isError, role, input } = args;
  const trimmed = text.trim();
  if (!trimmed) return '(no output)';
  if (isError || role === 'mutation') {
    return trimmed.length > WHOLE_RESULT_MAX_CHARS
      ? `${trimmed.slice(0, WHOLE_RESULT_MAX_CHARS)}… (${trimmed.length} chars)`
      : trimmed;
  }
  if (trimmed.length <= READ_WHOLE_MAX_CHARS) return trimmed;
  if (trimmed.length >= READ_BULKY_MIN_CHARS) {
    const ref = refetchReference(input);
    return `[${trimmed.length} chars omitted${ref ? `; re-fetch: ${ref}` : ''}]`;
  }
  return `${trimmed.slice(0, READ_WHOLE_MAX_CHARS)}… (${trimmed.length} chars)`;
}

function textOf(content: ProviderMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => ('type' in block && block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * The summarizer's reading of `messages`: oldest first, messages whole, tool calls condensed as
 * above. Same input, same output; a tool_use and the tool_result that follows it read as one line.
 */
export function buildSummarizerInput(messages: readonly ProviderMessage[]): string {
  const lines: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (isSummaryMessage(message)) continue;

    if (typeof message.content === 'string') {
      if (message.content.trim()) lines.push(`- ${message.role}: ${message.content}`);
      continue;
    }

    if (message.role === 'assistant') {
      const text = textOf(message.content).trim();
      if (text) lines.push(`- assistant: ${text}`);
      const uses = message.content.filter(
        (block): block is Extract<typeof block, { type: 'tool_use' }> =>
          'type' in block && block.type === 'tool_use'
      );
      if (uses.length === 0) continue;

      const results = new Map<string, { text: string; isError: boolean }>();
      const next = messages[i + 1];
      if (next && next.role === 'user' && Array.isArray(next.content)) {
        for (const block of next.content) {
          if ('type' in block && block.type === 'tool_result') {
            results.set(block.tool_use_id, {
              text: resultText(block.content),
              isError: block.is_error === true,
            });
          }
        }
        if (results.size > 0) i++; // the tool_result message is read with its calls
      }

      for (const use of uses) {
        const name = resolveEffectiveToolName(use) ?? use.name;
        const { role } = classifyToolCall(name, use.input);
        const result = results.get(use.id);
        const call = `${name}(${showInput(use.input)})`;
        lines.push(
          result
            ? `  → ${call} → ${describeResult({ text: result.text, isError: result.isError, role, input: use.input })}`
            : `  → ${call}`
        );
      }
      continue;
    }

    // A user turn made of blocks: tool results with no call in view, or text and images.
    const results = message.content.filter(
      (block) => 'type' in block && block.type === 'tool_result'
    );
    if (results.length > 0) {
      for (const block of results) {
        if ('type' in block && block.type === 'tool_result') {
          lines.push(
            `  → (result) ${describeResult({ text: resultText(block.content), isError: block.is_error === true, role: 'other', input: undefined })}`
          );
        }
      }
      continue;
    }
    const text = textOf(message.content).trim();
    const images = message.content.filter((block) => 'type' in block && block.type === 'image');
    if (text || images.length > 0) {
      const tag =
        images.length > 0 ? ` [${images.length} image${images.length > 1 ? 's' : ''}]` : '';
      lines.push(`- user:${tag} ${text}`.trimEnd());
    }
  }
  return lines.join('\n');
}
