/**
 * Durable-prefix overhead measurement — the two payload parts that ride on
 * every single request and are not messages: the composed system prompt and
 * the advertised tool catalog.
 *
 * The catalog is per-agent (access config, MCP servers, allow-list pins), so
 * it is measured from the rows handed in per request — never cached globally.
 */

import type { ToolRow } from '@snaglet/db/tables/tools';
import {
  formatToolsForProvider,
  toOpenAITools,
} from '@server/services/ToolService/ToolFormatService';
import { estimateTokens } from '@server/services/TokenEstimator';

/**
 * Real overhead measured by a caller that has already assembled the payload.
 * Every field is optional: callers without the real values (scripts, tests,
 * older call sites) still get a correct — merely less complete — budget.
 */
export interface ContextOverheadInput {
  /**
   * The system prompt actually sent: `flattenTextBlocks(composeSystemPrompt(…))`.
   * Replaces the agent's raw persona field in the budget rather than adding to
   * it — the persona is one block inside this text, so summing would double-count.
   */
  systemPromptText?: string | null;
  /** The tool rows advertised to the provider on this request. */
  toolRows?: readonly ToolRow[] | null;
}

/**
 * Token cost of the `tools` field for one request.
 *
 * Serializes through the same formatter the provider path uses, so the number
 * tracks the real wire payload (Anthropic's flattened schemas are meaningfully
 * smaller than the canonical ones for some tools). Providers without a
 * dedicated mapping ride the shared chat-completions wire, which is OpenAI
 * shaped — hence that fallback.
 */
export function measureToolCatalogTokens(
  tools: readonly ToolRow[],
  provider: string,
  modelId?: string
): number {
  if (tools.length === 0) return 0;
  const rows = tools as ToolRow[];
  const payload = formatToolsForProvider(provider, rows) ?? toOpenAITools(rows);
  return estimateTokens(JSON.stringify(payload), provider, modelId);
}
