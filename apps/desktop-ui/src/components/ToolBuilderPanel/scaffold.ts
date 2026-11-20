/**
 * Pure functions that turn ToolBuilderPanel form state into the on-disk
 * workspace files and back: `definition.json` (read by `syncDefinitionToDb`)
 * and `tool.ts` (a default-exported async `handler(input, context)`, see
 * buildToolBundle.ts). The server does not deep-validate `parametersSchema`,
 * so this module is the only check on its shape.
 */

import { validateWorkspaceItemName } from '@desktop/utils/workspaceItemName';

export type ParamType = 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object';

/** The real ToolModel tier enum (packages/db/tables/tools/ToolModel.ts). Not
 * derivable at runtime from a `type ToolTier = 'core' | 'standard'` alias —
 * TS types erase — so this literal array is the client-side companion const
 * kept in lockstep with that type by hand. */
export const TOOL_TIERS = ['core', 'standard'] as const;
export type ToolTier = (typeof TOOL_TIERS)[number];

export const DEFAULT_CATEGORY_PATH = 'custom';
export const DEFAULT_TIER: ToolTier = 'standard';

/** A workspace-sourced tool's `ToolRow.source` prefix (see CustomToolScanner's
 * `sourceFor`). Stable regardless of the tool's DB id, which is derived from
 * `definition.json`'s `name` (dashes -> underscores) and so can differ from
 * the folder name the workspace API keys on. */
const WORKSPACE_SOURCE_PREFIX = 'workspace:';

/** Extract a tool's workspace folder id (the `toolWorkspacesApi` key) from
 * its `ToolRow.source`, or null for a non-workspace (builtin/mcp) tool. */
export function toolIdFromSource(source: string | null | undefined): string | null {
  if (!source || !source.startsWith(WORKSPACE_SOURCE_PREFIX)) return null;
  return source.slice(WORKSPACE_SOURCE_PREFIX.length);
}

let rowIdCounter = 0;

/** One row of the ParamsSchemaEditor. `id` is a stable React key only — it
 * never reaches the assembled JSON-Schema. */
export interface ParamFieldRow {
  id: string;
  name: string;
  type: ParamType;
  required: boolean;
  description: string;
  /** Only meaningful when `type === 'enum'`. */
  enumValues: string[];
}

export function makeEmptyParamRow(): ParamFieldRow {
  rowIdCounter += 1;
  return {
    id: `row-${rowIdCounter}`,
    name: '',
    type: 'string',
    required: false,
    description: '',
    enumValues: [],
  };
}

/**
 * Validate a tool name, which is also its workspace folder id. The server
 * strips characters outside `[a-zA-Z0-9_-]` from folder names, so validating
 * here keeps the folder and `definition.json`'s `name` in step.
 *
 * Returns an error message, or null when valid.
 */
export function validateToolName(name: string): string | null {
  return validateWorkspaceItemName(name);
}

/** Assemble the ParamsSchemaEditor rows into a JSON-Schema `parametersSchema`. */
export function buildParametersSchema(rows: ParamFieldRow[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;

    const prop: Record<string, unknown> = {};
    if (row.type === 'enum') {
      prop.type = 'string';
      prop.enum = row.enumValues.map((v) => v.trim()).filter(Boolean);
    } else if (row.type === 'array') {
      prop.type = 'array';
      prop.items = {};
    } else {
      prop.type = row.type;
    }

    const description = row.description.trim();
    if (description) prop.description = description;

    properties[name] = prop;
    if (row.required) required.push(name);
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/** Parse a persisted `parametersSchema` back into editable rows (edit-mode round trip). */
export function parseParametersSchema(
  schema: Record<string, unknown> | null | undefined
): ParamFieldRow[] {
  if (!schema || typeof schema !== 'object') return [];
  const rawProps = (schema as Record<string, unknown>).properties;
  const properties =
    rawProps && typeof rawProps === 'object' ? (rawProps as Record<string, unknown>) : {};
  const requiredList = (schema as Record<string, unknown>).required;
  const requiredSet = new Set(
    Array.isArray(requiredList)
      ? requiredList.filter((v): v is string => typeof v === 'string')
      : []
  );

  return Object.entries(properties).map(([name, raw]) => {
    const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const hasEnum = Array.isArray(p.enum);
    const type: ParamType = hasEnum
      ? 'enum'
      : typeof p.type === 'string' &&
          ['string', 'number', 'boolean', 'array', 'object'].includes(p.type)
        ? (p.type as ParamType)
        : 'string';

    return {
      ...makeEmptyParamRow(),
      name,
      type,
      required: requiredSet.has(name),
      description: typeof p.description === 'string' ? p.description : '',
      enumValues: hasEnum
        ? (p.enum as unknown[]).filter((v): v is string => typeof v === 'string')
        : [],
    };
  });
}

/**
 * True when a `parametersSchema` round-trips losslessly through the row
 * editor (typed array `items`, nested objects, non-string enums and extra
 * keywords do not). When false, edit mode shows a read-only preview so a
 * save never drops a hand-authored shape.
 */
export function isSchemaRepresentable(schema: Record<string, unknown> | null | undefined): boolean {
  if (!schema || typeof schema !== 'object') return true; // absent schema — trivially representable

  // Root shape: only `type` ('object', or absent — object is implied for
  // tool params), `properties`, and `required` are modeled. Any other
  // top-level JSON-Schema keyword (`additionalProperties`,
  // `patternProperties`, a root-level `$schema`/`description`, ...) would be
  // silently dropped on rebuild, so its mere presence makes this unrepresentable
  // regardless of what `properties` looks like.
  const KNOWN_ROOT_KEYS = new Set(['type', 'properties', 'required']);
  if (Object.keys(schema).some((key) => !KNOWN_ROOT_KEYS.has(key))) return false;
  if (schema.type !== undefined && schema.type !== 'object') return false;

  // A present-but-malformed `properties` (null, a scalar, an array) is
  // unrepresentable, not silently-equal: parse collapses it to no rows and a
  // lenient comparison here would collapse it to {} on both sides, so a save
  // would "agree" and rewrite the malformed value to a clean empty schema —
  // exactly the destroy-what-you-can't-represent failure this check exists to
  // prevent. Same reasoning for a malformed (non-array) `required`.
  if (
    schema.properties !== undefined &&
    (schema.properties === null ||
      typeof schema.properties !== 'object' ||
      Array.isArray(schema.properties))
  ) {
    return false;
  }
  if (schema.required !== undefined && !Array.isArray(schema.required)) return false;

  const rebuilt = buildParametersSchema(parseParametersSchema(schema));
  const originalProperties = (schema.properties as Record<string, unknown> | undefined) ?? {};
  if (canonicalJson(rebuilt.properties) !== canonicalJson(originalProperties)) return false;

  // `required: []` and an absent `required` are semantically identical —
  // compare normalized (deduped + sorted) sets, not raw array equality, so
  // that harmless presentational difference alone never triggers a degrade.
  return (
    canonicalJson(normalizedRequired(rebuilt.required)) ===
    canonicalJson(normalizedRequired(schema.required))
  );
}

function normalizedRequired(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((v): v is string => typeof v === 'string'))).sort()
    : [];
}

/** Deterministic JSON string for structural comparison — sorts object keys
 * recursively so two objects differing only in key order still compare
 * equal. Values here are always plain JSON-Schema data (no Date/Map/etc). */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Working scaffold for a new tool's `tool.ts`: a default-exported async
 * handler that echoes its input, so a freshly created tool is callable with
 * no code written.
 */
export function scaffoldToolTs(toolName: string): string {
  return `import snaglet from '@snaglet/sdk';

/**
 * ${toolName} — generated by the Snaglet tool builder.
 * Echoes whatever input it receives. Edit this file to add real logic.
 */
export default async function handler(input, context) {
  await snaglet.log.info(\`${toolName} received input: \${JSON.stringify(input)}\`);
  return {
    tool: '${toolName}',
    receivedAt: new Date().toISOString(),
    input,
  };
}
`;
}

/** Working scaffold for the workspace's `TOOL.md` doc file. */
export function scaffoldToolMd(toolName: string, description: string): string {
  const desc = description.trim() || 'No description yet.';
  return `# ${toolName}

${desc}

Generated by the Snaglet tool builder. Edit \`tool.ts\` to customize behavior.
`;
}

/** Form state the ToolBuilderPanel edits and round-trips. */
export interface ToolBuilderFormState {
  name: string;
  description: string;
  categoryPath: string;
  tier: ToolTier;
  keywords: string[];
  paramRows: ParamFieldRow[];
  /**
   * Set (non-null) only in edit mode, when the loaded tool's persisted
   * `parametersSchema` doesn't round-trip through the row editor (see
   * `isSchemaRepresentable`). While set, `buildDefinitionJson` writes this
   * verbatim instead of rebuilding from `paramRows` — the form can edit
   * name/description/etc. without silently discarding a hand-authored shape
   * it can't display. Always null in create mode.
   */
  unrepresentableSchema?: Record<string, unknown> | null;
}

/** Assemble `definition.json`'s contents from form state. */
export function buildDefinitionJson(form: ToolBuilderFormState): string {
  const definition = {
    name: form.name.trim(),
    description: form.description.trim(),
    categoryPath: form.categoryPath.trim() || DEFAULT_CATEGORY_PATH,
    // Always null — derived server-side (syncDefinitionToDb), never a form input.
    providerId: null,
    tier: form.tier,
    // Pass an unrepresentable schema through untouched (see the field's doc
    // comment) — otherwise rebuild it from the editor's rows as usual.
    parametersSchema: form.unrepresentableSchema ?? buildParametersSchema(form.paramRows),
    keywords: form.keywords,
  };
  return JSON.stringify(definition, null, 2);
}

/**
 * The shape of a failed `toolWorkspacesApi.deploy()` result (see
 * `WorkspaceDeployResult`'s failure branch in utils/api/tools.ts) — modeled
 * structurally here rather than imported, so this file stays free of any
 * dependency on the API client.
 */
interface DeployFailure {
  step: 'install' | 'build';
  output: string;
  error?: string;
}

/**
 * Format a failed install/build result for the user. `error` is a one-line
 * summary ("pnpm install exited with code 1"); the real failure text is in
 * `output`. Show the summary, then the output, unless the output is empty or
 * repeats the summary.
 */
export function formatDeployFailure(result: DeployFailure): string {
  const stepLabel = result.step === 'install' ? 'Install' : 'Build';
  const summary = result.error?.trim() || 'Unknown error';
  const output = result.output.trim();
  if (!output || output === summary) {
    return `${stepLabel} failed: ${summary}`;
  }
  return `${stepLabel} failed: ${summary}\n\n${output}`;
}

/** Parse a workspace's `definition.json` object back into form state (edit mode). */
export function parseDefinition(
  definition: Record<string, unknown> | null | undefined
): ToolBuilderFormState {
  const d = definition && typeof definition === 'object' ? definition : {};
  const tier =
    typeof d.tier === 'string' && (TOOL_TIERS as readonly string[]).includes(d.tier)
      ? (d.tier as ToolTier)
      : DEFAULT_TIER;
  const rawSchema = d.parametersSchema as Record<string, unknown> | null | undefined;
  const representable = isSchemaRepresentable(rawSchema);

  return {
    name: typeof d.name === 'string' ? d.name : '',
    description: typeof d.description === 'string' ? d.description : '',
    categoryPath:
      typeof d.categoryPath === 'string' && d.categoryPath.trim()
        ? d.categoryPath
        : DEFAULT_CATEGORY_PATH,
    tier,
    keywords: Array.isArray(d.keywords)
      ? d.keywords.filter((k): k is string => typeof k === 'string')
      : [],
    // Unrepresentable schemas skip the row editor entirely (it would only
    // show a lossy approximation) — `unrepresentableSchema` carries the real
    // one through to the read-only preview and back out on save.
    paramRows: representable ? parseParametersSchema(rawSchema) : [],
    unrepresentableSchema: representable ? null : (rawSchema ?? null),
  };
}
