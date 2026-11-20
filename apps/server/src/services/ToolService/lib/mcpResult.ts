/**
 * Format a successful MCP tool result for return to a tool caller.
 * Strings pass through; objects are pretty-printed JSON. `rawContent`
 * always preserves the original payload so non-text blocks (e.g. images)
 * survive downstream serialization.
 */
export function formatMcpSuccess(content: unknown): {
  output: string;
  rawContent: unknown;
} {
  return {
    output: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    rawContent: content,
  };
}
