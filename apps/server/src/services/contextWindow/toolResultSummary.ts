/**
 * Historical-digest synthesis — turns folded-away messages and tool cycles
 * into the short inline summary that rides the compaction prefix when no
 * stored SummaryService text exists yet.
 */

import type { ProviderMessage } from '@server/services/ProviderChatService';
import {
  resolveEffectiveToolName,
  summarizeToolResultContent,
} from '@server/services/ToolService/toolResultFormat';
import { MAX_SUMMARY_CHARS, SUMMARY_DISCLAIMER } from './constants';

/**
 * Summarize a tool result for the folded-history digest. Same summarizer as the
 * live window (summarizeToolResultContent); errors are flagged rather than kept
 * whole and plain text gets a modest budget, since the digest is itself bounded
 * by maxSummaryChars.
 */
function summarizeToolResult(content: string, toolName?: string, isError?: boolean): string {
  return summarizeToolResultContent(content, {
    toolName,
    isError,
    onError: 'flag',
    textBudget: 600,
    previewRows: 2,
  });
}

/**
 * Condense provider payload messages without adding the historical-context
 * wrapper used by live prompt compression. Persistent thread summaries use
 * this directly so their LLM sees reasoning, tool cycles, and utterances while
 * large tool inputs/results remain bounded.
 */
export function buildPayloadDigest(
  oldMessages: ProviderMessage[],
  maxSummaryChars: number = MAX_SUMMARY_CHARS
): string {
  const lines: string[] = [];
  let totalChars = 0;
  let i = 0;

  const addLine = (line: string): boolean => {
    if (totalChars + line.length > maxSummaryChars) return false;
    lines.push(line);
    totalChars += line.length;
    return true;
  };

  while (i < oldMessages.length) {
    const msg = oldMessages[i];

    if (typeof msg.content === 'string') {
      // Plain text message (user or assistant)
      const preview = msg.content.length > 150 ? msg.content.slice(0, 150) + '…' : msg.content;
      if (!addLine(`- ${msg.role}: ${preview}`)) break;
      i++;
      continue;
    }

    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      // Assistant message with possible tool_use blocks — group with following tool_result
      const textParts: string[] = [];
      const toolCalls: { name: string; inputPreview: string }[] = [];

      for (const block of msg.content) {
        if ('type' in block && block.type === 'text') {
          textParts.push(block.text);
        } else if ('type' in block && block.type === 'tool_use') {
          const inputStr = JSON.stringify(block.input);
          const preview = inputStr.length > 60 ? inputStr.slice(0, 60) + '…' : inputStr;
          toolCalls.push({ name: block.name, inputPreview: preview });
        }
      }

      // If assistant had text, emit it
      if (textParts.length > 0 && toolCalls.length === 0) {
        const text = textParts.join(' ');
        const preview = text.length > 150 ? text.slice(0, 150) + '…' : text;
        if (!addLine(`- assistant: ${preview}`)) break;
        i++;
        continue;
      }

      // Map tool_use id → real tool id so result summaries can route by the
      // tool's return type rather than sniffing the content (every call is
      // wrapped by the `action` gateway, so the real id is in input.tool).
      const toolNameByUseId = new Map<string, string>();
      for (const block of msg.content as Array<{
        type?: string;
        id?: string;
        name?: unknown;
        input?: unknown;
      }>) {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          const effective = resolveEffectiveToolName(block);
          if (effective) toolNameByUseId.set(block.id, effective);
        }
      }

      // Collect tool results from the following user message
      const nextMsg = i + 1 < oldMessages.length ? oldMessages[i + 1] : null;
      const resultMap = new Map<string, string>();
      if (nextMsg && nextMsg.role === 'user' && Array.isArray(nextMsg.content)) {
        for (const block of nextMsg.content) {
          if (
            'type' in block &&
            block.type === 'tool_result' &&
            typeof block.content === 'string'
          ) {
            resultMap.set(
              block.tool_use_id,
              summarizeToolResult(
                block.content,
                toolNameByUseId.get(block.tool_use_id),
                block.is_error
              )
            );
          }
        }
      }

      // Emit brief assistant text if it preceded tool calls
      if (textParts.length > 0) {
        const text = textParts.join(' ');
        const preview = text.length > 80 ? text.slice(0, 80) + '…' : text;
        if (!addLine(`- assistant: ${preview}`)) break;
      }

      // Emit grouped tool call → result lines
      for (const tc of toolCalls) {
        // Find matching tool_use block to get its id for result lookup
        const useBlock = (msg.content as Array<{ type: string; id?: string; name?: string }>).find(
          (b) => b.type === 'tool_use' && b.name === tc.name
        );
        const result = useBlock?.id ? resultMap.get(useBlock.id) : undefined;
        const line = result
          ? `  → ${tc.name}(${tc.inputPreview}) → ${result}`
          : `  → ${tc.name}(${tc.inputPreview})`;
        if (!addLine(line)) break;
      }

      // Skip the tool_result message since we consumed it
      i += resultMap.size > 0 ? 2 : 1;
      continue;
    }

    // Standalone user tool_result message (shouldn't happen if grouped, but safety)
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const blocks = msg.content as Array<{
        type: string;
        content?: string;
        text?: string;
        is_error?: boolean;
      }>;
      const results = blocks
        .filter((b) => b.type === 'tool_result')
        .map((b) => summarizeToolResult(b.content ?? '', undefined, b.is_error));
      if (results.length > 0) {
        if (!addLine(`- tool results: ${results.join('; ')}`)) break;
        i++;
        continue;
      }
      // Multimodal user message: text segments + image blocks
      const textParts = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '');
      const imageCount = blocks.filter((b) => b.type === 'image').length;
      if (textParts.length > 0 || imageCount > 0) {
        const text = textParts.join(' ').trim();
        const preview = text.length > 150 ? text.slice(0, 150) + '…' : text;
        const imageTag = imageCount > 0 ? ` [${imageCount} image${imageCount > 1 ? 's' : ''}]` : '';
        if (!addLine(`- user:${imageTag} ${preview}`.trimEnd())) break;
      }
      i++;
      continue;
    }

    i++;
  }

  return lines.join('\n');
}

/**
 * Build a static summary from old messages.
 *
 * Groups tool-call cycles (assistant tool_use + user tool_result) into
 * meaningful per-cycle summaries that preserve what was *learned*, not just
 * what was called. Conversation text is previewed normally.
 */
export function buildSummary(
  oldMessages: ProviderMessage[],
  maxSummaryChars: number = MAX_SUMMARY_CHARS,
  /**
   * Roster + dispatch-mode snapshot to carry forward. The
   * `thread_event` rows that narrate roster/mode changes get folded away when
   * old turns are summarized, so the current state is restated here or it would
   * be lost from the agent's perceivable context.
   */
  carryForward?: string | null
): string {
  const digest = buildPayloadDigest(oldMessages, maxSummaryChars);
  return [
    `[Historical context summary — ${oldMessages.length} earlier messages omitted]`,
    SUMMARY_DISCLAIMER,
    ...(carryForward && carryForward.trim() ? ['', carryForward.trim()] : []),
    '',
    digest,
  ].join('\n');
}
