/**
 * Pure helpers for the tool test console — schema→args seeding and the
 * nested-tool-call refusal translation, React-free and unit-testable.
 */

/**
 * Skeleton args object seeded from a tool's `parametersSchema`: each declared
 * property gets its schema `default` when present, its first `enum` value,
 * or an empty-by-type placeholder — so the JSON editor starts as a fill-in
 * template instead of a blank `{}`.
 */
export function seedArgsFromSchema(
  schema: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return {};
  const rawProps = (schema as { properties?: unknown }).properties;
  if (!rawProps || typeof rawProps !== 'object' || Array.isArray(rawProps)) return {};
  const seeded: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(rawProps as Record<string, unknown>)) {
    const prop =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    if ('default' in prop) {
      seeded[name] = prop.default;
      continue;
    }
    if (Array.isArray(prop.enum) && prop.enum.length > 0) {
      seeded[name] = prop.enum[0];
      continue;
    }
    switch (prop.type) {
      case 'number':
      case 'integer':
        seeded[name] = 0;
        break;
      case 'boolean':
        seeded[name] = false;
        break;
      case 'array':
        seeded[name] = [];
        break;
      case 'object':
        seeded[name] = {};
        break;
      default:
        seeded[name] = '';
    }
  }
  return seeded;
}

/** `seedArgsFromSchema` pretty-printed for the JSON editor. */
export function seedArgsJson(schema: Record<string, unknown> | null | undefined): string {
  return JSON.stringify(seedArgsFromSchema(schema), null, 2);
}

const NESTED_REFUSAL_PATTERNS = [
  // The refusal a test run can hit: the nested call names a tool outside
  // ghost's allow list (execution.routes.ts /execute policy check). The
  // sandbox's @snaglet/sdk is the deployed runtime, which throws
  // "Snaglet server returned 403: <response body>", so match anywhere in the text.
  /Blocked by tool-access policy/i,
];

/**
 * Friendly translation for a nested tool call refused inside the test
 * sandbox. A test run has no agent, so its nested calls act as the ghost
 * system actor and are gated by ghost's allow list (GHOST_TOOL_ACCESS in the
 * server's agentToolPolicy.ts; keep the tool names below in step with it),
 * exactly as a saved tool a person runs. Returns the explanation when `text`
 * carries such a refusal, else null.
 */
export function explainNestedToolRefusal(text: string): string | null {
  if (!NESTED_REFUSAL_PATTERNS.some((pattern) => pattern.test(text))) return null;
  return (
    'Test runs act as the ghost system actor, so tool calls made through @snaglet/sdk ' +
    '(snaglet.tools.execute, snaglet.tables.read) may only use table, thread_send, thread_read and ' +
    'database_query (plus tool search and get_current_datetime, which every allow list ' +
    'keeps). A saved tool runs the same way when a person runs it; when an agent calls it, ' +
    "it uses that agent's own tool access instead."
  );
}
