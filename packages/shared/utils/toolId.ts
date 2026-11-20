/**
 * Tool id grammar: one or more letters, digits, `_` or `-`.
 *
 * This is the rule the tool workspace service enforces on a custom tool's id.
 * Custom tool ids are name slugs (`weather`, `weather_today`), not node-style
 * timestamp ids or UUIDs, so a tool reference (`[Title](tool:<id>)`) is
 * parsed with this grammar rather than the node-id one.
 */

/** Regex source (no anchors, no flags) for a tool id. */
export const TOOL_ID_SOURCE = '[A-Za-z0-9_-]+';

const TOOL_ID_RE = new RegExp(`^${TOOL_ID_SOURCE}$`);

export function isToolId(value: unknown): value is string {
  return typeof value === 'string' && TOOL_ID_RE.test(value);
}
