/**
 * runSummaryPrompts — the task-state prompt for in-run compaction, and the
 * renderer that turns a folded span of a live run (tool cycles, the agent's own
 * text, messages received mid-run) into bounded plain text for the summarizer.
 *
 * A thread summary is narrative memory of a conversation; an in-run summary is
 * working state for an agent that keeps going after its earlier steps leave its
 * context. So the prompt asks for labeled sections of concrete facts, not
 * prose. Plain text only (small local models fail structured output).
 */

import type { ProviderMessage } from '@server/services/ProviderChatService';
import { resolveEffectiveToolName } from '@server/services/ToolService/toolResultFormat';
import { extractActionParams } from '@server/services/ToolService/lib/extractActionParams';
import { isRecord } from '@snaglet/shared/utils';

/** Words to ask for: about 45% of the token cap, so a normal summary never hits it. */
function runSummaryWordTarget(maxOutputTokens: number): number {
  return Math.max(80, Math.floor(maxOutputTokens * 0.45));
}

export function buildRunSummaryInstructions(maxOutputTokens: number): string {
  return [
    'You compress the working state of an AI agent that is partway through a task. Its earlier',
    'steps are about to be removed from its context; your summary replaces them, and the agent',
    'continues from it. Write plain text with exactly these labeled sections, in this order:',
    '',
    'Goal: what the agent was asked to do, from the TASK. One or two sentences.',
    'Next step: the exact next action the agent was about to take, or "Done" if the work is finished.',
    'Files: one line per file created, changed or deleted — the exact path, what changed, and why.',
    'Commands and results: one line per command, test or check run — the command and its outcome',
    '(pass/fail, counts, the key output or error text).',
    'Decisions: choices made and the reason for each, including approaches tried and abandoned.',
    'Open errors: failures, failing tests or problems not yet fixed, with exact messages. "None" if none.',
    'Instructions received: anything the user or another agent said during the work, close to',
    'verbatim. "None" if none.',
    'Facts: other concrete values the agent will need again — ids, names, URLs, settings, line numbers.',
    '',
    'Rules: give exact paths, names, ids, numbers and error text, never vague narrative. Use only',
    'what the record shows; do not invent results. If an EARLIER SUMMARY is given, fold it in and',
    'keep everything in it that is still true. Write "None" for an empty section. Output only the',
    `summary, no preamble. Keep it under ${runSummaryWordTarget(maxOutputTokens)} words.`,
  ].join('\n');
}

export function buildRunSummaryPrompt(input: {
  goal: string;
  previousSummary: string | null;
  transcript: string;
  foldedMessages: number;
}): string {
  const parts = [`TASK (the request that started this run):\n${input.goal || '(not shown)'}`];
  if (input.previousSummary) {
    parts.push(`EARLIER SUMMARY OF THIS RUN:\n${input.previousSummary}`);
  }
  parts.push(
    `STEPS TO SUMMARIZE (${input.foldedMessages} messages, oldest first):\n${input.transcript}`
  );
  return parts.join('\n\n');
}

interface RenderCaps {
  text: number;
  field: number;
  result: number;
}

const START_CAPS: RenderCaps = { text: 1_500, field: 600, result: 1_200 };
const FLOOR_CAPS: RenderCaps = { text: 160, field: 80, result: 160 };

function clipHead(value: string, cap: number): string {
  return value.length <= cap ? value : `${value.slice(0, cap)}… [+${value.length - cap} chars]`;
}

/** Head and tail: tool output tends to end with the line that matters (a test summary, an error). */
function clipHeadTail(value: string, cap: number): string {
  if (value.length <= cap) return value;
  const head = Math.ceil(cap * 0.6);
  const tail = cap - head;
  return `${value.slice(0, head)}… [${value.length - cap} chars cut] …${value.slice(value.length - tail)}`;
}

/**
 * Each argument clipped on its own, so a short `path` or `command` survives
 * next to a long `content`.
 */
function renderArgs(args: Record<string, unknown>, cap: number): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    parts.push(`${key}=${clipHead(text ?? 'null', cap)}`);
  }
  return parts.join(' ');
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string'
        ? part.text
        : '[image]'
    )
    .join('\n');
}

function renderLines(messages: readonly ProviderMessage[], caps: RenderCaps): string[] {
  const lines: string[] = [];
  const toolNameByUseId = new Map<string, string>();
  for (const message of messages) {
    if (typeof message.content === 'string') {
      const who = message.role === 'assistant' ? 'agent' : 'message';
      lines.push(`[${who}] ${clipHead(message.content.trim(), caps.text)}`);
      continue;
    }
    for (const block of message.content) {
      if (block.type === 'text') {
        if (!block.text.trim()) continue;
        const who = message.role === 'assistant' ? 'agent' : 'message';
        lines.push(`[${who}] ${clipHead(block.text.trim(), caps.text)}`);
      } else if (block.type === 'image') {
        lines.push('[message] [image]');
      } else if (block.type === 'tool_use') {
        const name = resolveEffectiveToolName(block) ?? block.name;
        toolNameByUseId.set(block.id, name);
        const isGateway = block.name === 'action' || block.name.startsWith('action__');
        const args = isGateway ? extractActionParams(block.input) : block.input;
        lines.push(`[call] ${name} ${renderArgs(args, caps.field)}`.trimEnd());
      } else if (block.type === 'tool_result') {
        const name = toolNameByUseId.get(block.tool_use_id) ?? 'tool';
        const label = block.is_error ? `[error] ${name}` : `[result] ${name}`;
        lines.push(`${label}: ${clipHeadTail(toolResultText(block.content).trim(), caps.result)}`);
      }
    }
  }
  return lines;
}

/**
 * Render a folded span for the summarizer within `maxChars`. Per-item caps
 * halve until the whole span fits; past the floor caps, the oldest and newest
 * steps are kept and the middle is dropped with a marker. Deterministic.
 */
export function renderRunSpanForSummary(
  messages: readonly ProviderMessage[],
  maxChars: number
): string {
  let caps = START_CAPS;
  let lines = renderLines(messages, caps);
  const size = (rendered: string[]): number =>
    rendered.reduce((sum, line) => sum + line.length + 1, 0);
  while (size(lines) > maxChars && caps.text > FLOOR_CAPS.text) {
    caps = {
      text: Math.max(FLOOR_CAPS.text, Math.floor(caps.text / 2)),
      field: Math.max(FLOOR_CAPS.field, Math.floor(caps.field / 2)),
      result: Math.max(FLOOR_CAPS.result, Math.floor(caps.result / 2)),
    };
    lines = renderLines(messages, caps);
  }
  if (size(lines) <= maxChars) return lines.join('\n');

  const half = Math.floor(maxChars / 2);
  const head: string[] = [];
  let headSize = 0;
  for (const line of lines) {
    if (headSize + line.length + 1 > half) break;
    head.push(line);
    headSize += line.length + 1;
  }
  const tail: string[] = [];
  let tailSize = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    const line = lines[i]!;
    if (tailSize + line.length + 1 > half) break;
    tail.unshift(line);
    tailSize += line.length + 1;
  }
  const omitted = lines.length - head.length - tail.length;
  return [...head, `[… ${omitted} steps omitted to fit …]`, ...tail].join('\n');
}
