/**
 * llmPayloadLog.ts — one log line per model call: agent, model, thread,
 * iteration and counts. The log never carries conversation text by default;
 * with SNAGLET_LOG_CONTENT=1 it also lists the system blocks and messages with
 * short previews, for debugging prompt assembly.
 */

import { LogsService } from '@server/services/LogsService';
import { logsContent } from '@server/services/logContent';
import type {
  ProviderMessage,
  SystemContentBlock,
} from '@server/services/ProviderChatService/types';
import type { ContextBudget } from '@server/services/ContextWindowService';

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
};

function preview(text: string, max: number = 80): string {
  const oneLine = text.replace(/\n/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '...' : oneLine;
}

function formatMessageLine(idx: number, msg: ProviderMessage): string {
  const num = String(idx + 1).padStart(3, ' ');

  // Plain text message
  if (typeof msg.content === 'string') {
    const role =
      msg.role === 'user' ? `${ANSI.green}user${ANSI.reset}` : `${ANSI.blue}assistant${ANSI.reset}`;
    const chars = `${msg.content.length} chars`;
    return `  ${ANSI.dim}${num}.${ANSI.reset} ${role.padEnd(20)} ${ANSI.dim}${chars.padEnd(12)}${ANSI.reset} ${ANSI.dim}"${preview(msg.content)}"${ANSI.reset}`;
  }

  // Assistant with tool_use blocks
  if (msg.role === 'assistant' && Array.isArray(msg.content)) {
    const textParts = msg.content.filter((b) => 'type' in b && b.type === 'text');
    const toolParts = msg.content.filter((b) => 'type' in b && b.type === 'tool_use') as Array<{
      type: 'tool_use';
      name: string;
      input: Record<string, unknown>;
    }>;

    const parts: string[] = [];
    if (textParts.length > 0) {
      const text = textParts.map((b) => ('text' in b ? b.text : '')).join(' ');
      parts.push(`"${preview(text, 50)}"`);
    }
    for (const t of toolParts) {
      const inputStr = JSON.stringify(t.input);
      parts.push(
        `${ANSI.yellow}${t.name}${ANSI.reset}(${ANSI.dim}${preview(inputStr, 40)}${ANSI.reset})`
      );
    }

    return `  ${ANSI.dim}${num}.${ANSI.reset} ${ANSI.blue}assistant${ANSI.reset}      ${ANSI.dim}tool_use${ANSI.reset}     ${parts.join(' + ')}`;
  }

  // User with tool_result blocks
  if (msg.role === 'user' && Array.isArray(msg.content)) {
    const blocks = msg.content as Array<{
      type: string;
      tool_use_id?: string;
      content?: string;
      is_error?: boolean;
      text?: string;
    }>;
    const isToolResult = blocks.some((b) => b.type === 'tool_result');
    if (isToolResult) {
      const summaries = blocks.map((r) => {
        const size = r.content ? `${r.content.length} chars` : '0 chars';
        const err = r.is_error ? ` ${ANSI.yellow}ERROR${ANSI.reset}` : '';
        return `${ANSI.dim}${size}${ANSI.reset}${err}`;
      });
      return `  ${ANSI.dim}${num}.${ANSI.reset} ${ANSI.green}user${ANSI.reset}           ${ANSI.dim}tool_result${ANSI.reset}   ${summaries.join(', ')}`;
    }
    // Multimodal: text + image segments
    const textParts = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '');
    const imageCount = blocks.filter((b) => b.type === 'image').length;
    const text = textParts.join(' ');
    const tag = imageCount > 0 ? `[${imageCount} image${imageCount > 1 ? 's' : ''}]` : '';
    return `  ${ANSI.dim}${num}.${ANSI.reset} ${ANSI.green}user${ANSI.reset}           ${ANSI.dim}multimodal${ANSI.reset}    ${ANSI.magenta}${tag}${ANSI.reset} ${ANSI.dim}"${preview(text, 50)}"${ANSI.reset}`;
  }

  return `  ${ANSI.dim}${num}. ${msg.role}${ANSI.reset}`;
}

interface PayloadLogParams {
  agentName: string;
  model: string;
  threadName?: string;
  threadId: string;
  systemBlocks: SystemContentBlock[];
  messages: ProviderMessage[];
  tools: string[];
  budget: ContextBudget;
  iteration: number;
  isGroup?: boolean;
}

/** Labels for system blocks by index — group chat layout */
const GROUP_BLOCK_LABELS = ['scaffold', 'identity + tools', 'participants'];
/** Labels for system blocks by index — direct chat layout */
const DIRECT_BLOCK_LABELS = ['identity + tools'];

/** Detect the "purpose" of a system block by inspecting its content */
function labelSystemBlock(
  idx: number,
  block: SystemContentBlock,
  isGroup: boolean,
  totalBuiltIn: number
): string {
  // Built-in blocks (from PerceptionService) get positional labels
  if (idx < totalBuiltIn) {
    const labels = isGroup ? GROUP_BLOCK_LABELS : DIRECT_BLOCK_LABELS;
    return labels[idx] ?? `block ${idx}`;
  }

  // Injected blocks — detect by content heuristics
  const text = block.text.slice(0, 200).toLowerCase();
  if (text.includes('[system note:') && text.includes('responded')) return 'dispatch threshold';
  if (text.includes('thread') || text.includes('review') || text.includes('task'))
    return 'thread system prompt';
  return 'injected';
}

function formatSystemBlockLine(label: string, block: SystemContentBlock): string {
  const chars = block.text.length;
  const cached = block.cache_control ? `${ANSI.cyan}cached${ANSI.reset} ` : '';
  const firstLine = block.text.replace(/\n/g, ' ').trim();
  const snip = firstLine.length > 90 ? firstLine.slice(0, 90) + '...' : firstLine;
  return `  ${ANSI.dim}•${ANSI.reset} ${ANSI.yellow}${label}${ANSI.reset} ${cached}${ANSI.dim}(${chars} chars)${ANSI.reset} ${ANSI.dim}"${snip}"${ANSI.reset}`;
}

export function logLlmPayload(params: PayloadLogParams): void {
  const {
    agentName,
    model,
    threadName,
    systemBlocks,
    messages,
    tools,
    budget,
    iteration,
    isGroup,
  } = params;

  const userCount = messages.filter((m) => m.role === 'user').length;
  const asstCount = messages.filter((m) => m.role === 'assistant').length;
  const totalSysChars = systemBlocks.reduce((sum, b) => sum + b.text.length, 0);
  const threadLabel = threadName ?? params.threadId.slice(0, 12);
  const builtInCount = isGroup ? 3 : 1;

  if (!logsContent()) {
    LogsService.info(
      `LLM call ${agentName} → ${model} │ thread: ${threadLabel} │ iter ${iteration} │ ` +
        `${messages.length} messages (${userCount} user, ${asstCount} assistant) │ ` +
        `${systemBlocks.length} system blocks, ${totalSysChars} chars │ ${tools.length} tools │ ` +
        `budget ${budget.usableBudget} tokens`
    );
    return;
  }

  const lines: string[] = [
    `${ANSI.cyan}${ANSI.bold}── LLM Payload ──${ANSI.reset} ${ANSI.magenta}${agentName}${ANSI.reset} ${ANSI.dim}→ ${model} │ thread: ${threadLabel} │ iter ${iteration}${ANSI.reset}`,
    `  ${ANSI.dim}budget:${ANSI.reset} ${budget.usableBudget} tokens  ${ANSI.dim}│${ANSI.reset}  ${ANSI.dim}tools:${ANSI.reset} ${tools.length > 0 ? tools.join(', ') : 'none'}`,
    `  ${ANSI.dim}system prompt (${systemBlocks.length} blocks, ${totalSysChars} chars total):${ANSI.reset}`,
  ];

  for (let i = 0; i < systemBlocks.length; i++) {
    const label = labelSystemBlock(i, systemBlocks[i], !!isGroup, builtInCount);
    lines.push(formatSystemBlockLine(label, systemBlocks[i]));
  }

  lines.push(
    `  ${ANSI.dim}messages (${messages.length}): ${userCount} user, ${asstCount} assistant${ANSI.reset}`
  );

  for (let i = 0; i < messages.length; i++) {
    lines.push(formatMessageLine(i, messages[i]));
  }

  LogsService.info(lines.join('\n'));
}
