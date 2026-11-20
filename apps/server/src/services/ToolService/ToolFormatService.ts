/**
 * ToolFormatService — translates Snaglet tool definitions into provider-specific formats.
 *
 * Each provider has its own tool/function-calling schema. This service converts
 * from the canonical Snaglet format (stored in the tools table) to what each provider API expects.
 */

import type { ToolRow } from '@snaglet/db/tables/tools';

type ToolWithSchema = Pick<ToolRow, 'id' | 'name' | 'description'> & {
  parameters_schema?: Record<string, unknown>;
  parametersSchema?: Record<string, unknown>;
};

export function getToolParametersSchema(tool: ToolWithSchema): Record<string, unknown> {
  return tool.parametersSchema ?? tool.parameters_schema ?? {};
}

export interface AnthropicTool {
  type: 'custom';
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const ANTHROPIC_UNSUPPORTED_ROOT_COMBINATORS = ['oneOf', 'allOf', 'anyOf'] as const;

function schemaObjects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object' && !Array.isArray(item)
      )
    : [];
}

function schemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
  const value = schema.properties;
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredProperties(schema: Record<string, unknown>): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === 'string')
    : [];
}

function mergeAlternativePropertySchemas(schemas: unknown[]): unknown {
  if (schemas.length === 1) return schemas[0];
  if (schemas.every((schema) => JSON.stringify(schema) === JSON.stringify(schemas[0]))) {
    return schemas[0];
  }

  const records = schemas.filter(
    (schema): schema is Record<string, unknown> =>
      schema !== null && typeof schema === 'object' && !Array.isArray(schema)
  );
  const merged: Record<string, unknown> = {};
  const types = [...new Set(records.map((schema) => schema.type).filter(Boolean))];
  if (types.length === 1) merged.type = types[0];
  const description = records.find((schema) => typeof schema.description === 'string')?.description;
  if (description) merged.description = description;

  const allowedValues = records.flatMap((schema) => {
    if ('const' in schema) return [schema.const];
    return Array.isArray(schema.enum) ? schema.enum : [];
  });
  if (allowedValues.length > 0) merged.enum = [...new Set(allowedValues)];

  return Object.keys(merged).length > 0 ? merged : schemas[0];
}

/**
 * Anthropic rejects oneOf/allOf/anyOf ANYWHERE in a tool input schema, not
 * just at the root. Flatten combinators at every depth for transport — root,
 * nested object properties, and array items — while leaving the canonical
 * schema untouched for discovery and runtime validation.
 *
 * Not Anthropic-only despite the name: strict OpenAI-style surfaces (Copilot's
 * `/chat/completions`, Copilot- and ChatGPT-backed Codex `/responses`,
 * gemini-via-copilot) also 400 on a top-level `anyOf`/`oneOf`/`allOf` (e.g.
 * apply_patch's `anyOf: [{required:['patch']}, {required:['input']}]`) —
 * Copilot returns a plain "Bad Request" and gemini-via-copilot a generic
 * "invalid request body". Flattening collapses those combinators (root +
 * nested) into a plain object schema, keeping every property and the shared
 * requirements so params still round-trip.
 */
export function normalizeAnthropicInputSchema(
  schema: Record<string, unknown>
): Record<string, unknown> {
  const hasUnsupportedRootKeyword = ANTHROPIC_UNSUPPORTED_ROOT_COMBINATORS.some(
    (keyword) => keyword in schema
  );
  // No root combinator: still recurse so nested combinators get stripped.
  if (!hasUnsupportedRootKeyword) return normalizeAnthropicSchemaChildren(schema);

  const normalized: Record<string, unknown> = { ...schema };
  for (const keyword of ANTHROPIC_UNSUPPORTED_ROOT_COMBINATORS) delete normalized[keyword];

  const properties = { ...schemaProperties(schema) };
  const baseRequired = new Set(requiredProperties(schema));

  const allOf = schemaObjects(schema.allOf).map(normalizeAnthropicInputSchema);
  for (const branch of allOf) {
    for (const [name, propertySchema] of Object.entries(schemaProperties(branch))) {
      if (!(name in properties)) properties[name] = propertySchema;
    }
    for (const name of requiredProperties(branch)) baseRequired.add(name);
  }

  const alternatives = [...schemaObjects(schema.oneOf), ...schemaObjects(schema.anyOf)].map(
    normalizeAnthropicInputSchema
  );
  const alternativeProperties = new Map<string, unknown[]>();
  for (const branch of alternatives) {
    for (const [name, propertySchema] of Object.entries(schemaProperties(branch))) {
      const variants = alternativeProperties.get(name) ?? [];
      variants.push(propertySchema);
      alternativeProperties.set(name, variants);
    }
  }
  for (const [name, variants] of alternativeProperties) {
    if (!(name in properties)) properties[name] = mergeAlternativePropertySchemas(variants);
  }

  if (alternatives.length > 0) {
    const commonRequired = alternatives
      .map((branch) => new Set(requiredProperties(branch)))
      .reduce((common, branch) => new Set([...common].filter((name) => branch.has(name))));
    for (const name of commonRequired) baseRequired.add(name);
  }

  normalized.type = 'object';
  normalized.properties = properties;
  if (baseRequired.size > 0) normalized.required = [...baseRequired];
  else delete normalized.required;
  return normalizeAnthropicSchemaChildren(normalized);
}

/**
 * Recurse into a schema's `properties` and array `items`, stripping nested
 * oneOf/allOf/anyOf combinators at any depth. Returns a shallow-cloned schema;
 * the input is never mutated.
 */
function normalizeAnthropicSchemaChildren(
  schema: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema };

  const props = out.properties;
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    const nextProps: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(props as Record<string, unknown>)) {
      nextProps[name] =
        value && typeof value === 'object' && !Array.isArray(value)
          ? normalizeAnthropicInputSchema(value as Record<string, unknown>)
          : value;
    }
    out.properties = nextProps;
  }

  const items = out.items;
  if (items && typeof items === 'object' && !Array.isArray(items)) {
    out.items = normalizeAnthropicInputSchema(items as Record<string, unknown>);
  } else if (Array.isArray(items)) {
    out.items = items.map((entry) =>
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? normalizeAnthropicInputSchema(entry as Record<string, unknown>)
        : entry
    );
  }

  return out;
}

export function toAnthropicTools(tools: ToolRow[]): AnthropicTool[] {
  return tools.map((t) => ({
    type: 'custom',
    name: t.id,
    description: t.description,
    input_schema: normalizeAnthropicInputSchema(getToolParametersSchema(t)),
  }));
}

export interface ToolCatalogMetrics {
  toolCount: number;
  serializedBytes: number;
  estimatedTokens: number;
}

/**
 * Measure the exact Anthropic `tools` payload Snaglet builds before the provider
 * adds its cache-control marker. The byte/4 token estimate is deliberately
 * simple and stable: this is catalog regression telemetry, not billing data.
 */
export function measureAnthropicToolCatalog(tools: ToolRow[]): ToolCatalogMetrics {
  const serialized = JSON.stringify(toAnthropicTools(tools));
  const serializedBytes = Buffer.byteLength(serialized, 'utf8');
  return {
    toolCount: tools.length,
    serializedBytes,
    estimatedTokens: Math.ceil(serializedBytes / 4),
  };
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * `flattenSchemas` collapses `anyOf`/`oneOf`/`allOf` combinators for strict
 * OpenAI-style wires that reject them (Copilot + Codex). Left off by default so
 * the canonical OpenAI wire keeps schemas verbatim.
 */
export function toOpenAITools(tools: ToolRow[], opts?: { flattenSchemas?: boolean }): OpenAITool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.id,
      description: t.description,
      parameters: opts?.flattenSchemas
        ? normalizeAnthropicInputSchema(getToolParametersSchema(t))
        : getToolParametersSchema(t),
    },
  }));
}

interface GeminiToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GeminiTools {
  functionDeclarations: GeminiToolDeclaration[];
}

export function toGeminiTools(tools: ToolRow[]): GeminiTools {
  return {
    functionDeclarations: tools.map((t) => ({
      name: t.id,
      description: t.description,
      parameters: getToolParametersSchema(t),
    })),
  };
}

export function formatToolsForProvider(
  provider: string,
  tools: ToolRow[]
): AnthropicTool[] | OpenAITool[] | GeminiTools | null {
  if (tools.length === 0) return null;

  const normalized = provider.toLowerCase();
  if (normalized === 'anthropic') return toAnthropicTools(tools);
  if (normalized === 'openai' || normalized === 'codex') return toOpenAITools(tools);
  if (normalized === 'google' || normalized === 'gemini') return toGeminiTools(tools);

  return null;
}
