/**
 * Layer 2 — Executable Result Contract
 *
 * Wraps tool metadata returned by discovery handlers (`tool`,
 * `list_tools`) into a uniform, immediately-invokable shape so weak models
 * stop having to derive invocation parameters from prose.
 *
 */

export interface ToolResultContract {
  /** Canonical tool id — exactly what `action` expects. */
  id: string;
  name: string;
  description: string;
  category_path?: string;
  provider_id?: string | null;
  tier?: string;
  keywords?: string[];
  aliases?: string[];
  parameters_schema?: Record<string, unknown>;

  /** Layer 2 additions — the executable contract. */
  callable: true;
  invoke: {
    via: 'action';
    tool: string;
    params_shape: 'object';
  };
  required_params: string[];
  example_call: {
    tool: string;
    params: Record<string, unknown>;
  };
}

type RawToolLike = {
  id: string;
  name?: string;
  description?: string;
  category_path?: string;
  provider_id?: string | null;
  tier?: string;
  keywords?: string[] | null;
  aliases?: string[] | null;
  parameters_schema?: Record<string, unknown> | null;
};

/**
 * Extract the list of required parameter names from a JSON-Schema-shaped
 * `parameters_schema`. Returns `[]` when the schema is missing, malformed,
 * or has no `required` array — never throws.
 */
export function extractRequiredParams(
  schema: Record<string, unknown> | null | undefined
): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const required = (schema as { required?: unknown }).required;
  if (!Array.isArray(required)) return [];
  return required.filter((v): v is string => typeof v === 'string');
}

/**
 * Build a minimal, syntactically-valid example `action` call for a tool.
 *
 * For each required param we emit a placeholder typed by the schema's
 * `properties[param].type`. Non-required params are omitted to keep the
 * example short and unambiguous.
 */
export function buildExampleCall(
  toolId: string,
  schema: Record<string, unknown> | null | undefined
): { tool: string; params: Record<string, unknown> } {
  const required = extractRequiredParams(schema);
  const properties =
    schema && typeof schema === 'object'
      ? ((schema as { properties?: Record<string, unknown> }).properties ?? {})
      : {};

  const params: Record<string, unknown> = {};
  for (const key of required) {
    const prop = (properties as Record<string, unknown>)[key];
    params[key] = placeholderForProperty(prop);
  }

  return { tool: toolId, params };
}

function placeholderForProperty(prop: unknown): unknown {
  if (!prop || typeof prop !== 'object') return '<value>';
  const type = (prop as { type?: unknown }).type;
  switch (type) {
    case 'string':
      return '<string>';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return '<value>';
  }
}

/**
 * Wrap a raw tool record in the executable result contract.
 *
 * Pure function. Safe to call on partial records (e.g. `searchByKeyword`
 * results that don't include `source`). Missing optional fields are
 * preserved as `undefined` rather than fabricated.
 */
export function wrapToolResult(raw: RawToolLike): ToolResultContract {
  const required = extractRequiredParams(raw.parameters_schema);
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    description: raw.description ?? '',
    category_path: raw.category_path,
    provider_id: raw.provider_id ?? undefined,
    tier: raw.tier,
    keywords: raw.keywords ?? undefined,
    aliases: raw.aliases ?? undefined,
    parameters_schema: raw.parameters_schema ?? undefined,
    callable: true,
    invoke: {
      via: 'action',
      tool: raw.id,
      params_shape: 'object',
    },
    required_params: required,
    example_call: buildExampleCall(raw.id, raw.parameters_schema),
  };
}

export function wrapToolResults(raws: RawToolLike[]): ToolResultContract[] {
  return raws.map(wrapToolResult);
}
