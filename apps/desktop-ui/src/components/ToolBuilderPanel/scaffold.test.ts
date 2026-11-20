/**
 * ToolBuilderPanel scaffold logic — pure functions with no React/DOM
 * dependency, so these run as plain unit tests:
 *   - validateToolName: folder-safe name gate (the name IS the workspace
 *     folder id, so it must match ToolWorkspaceService's sanitize set).
 *   - buildParametersSchema / parseParametersSchema: the ParamsSchemaEditor
 *     row <-> JSON-Schema round trip.
 *   - scaffoldToolTs / scaffoldToolMd / buildDefinitionJson: the exact file
 *     contents written on create (must match the `@snaglet/sdk` handler contract
 *     buildToolBundle.ts documents: `import snaglet from '@snaglet/sdk'; export default
 *     async function handler(input, context) { ... }`).
 */
import { describe, expect, it } from 'vitest';
import {
  buildDefinitionJson,
  buildParametersSchema,
  DEFAULT_CATEGORY_PATH,
  formatDeployFailure,
  isSchemaRepresentable,
  makeEmptyParamRow,
  parseDefinition,
  parseParametersSchema,
  scaffoldToolMd,
  scaffoldToolTs,
  toolIdFromSource,
  TOOL_TIERS,
  validateToolName,
  type ParamFieldRow,
} from './scaffold';

describe('validateToolName', () => {
  it('rejects an empty name', () => {
    expect(validateToolName('')).toBe('Name is required.');
    expect(validateToolName('   ')).toBe('Name is required.');
  });

  it('rejects names with spaces, slashes, or dots — not folder-safe', () => {
    const expected = 'Name must contain only letters, numbers, "-", or "_".';
    expect(validateToolName('my tool')).toBe(expected);
    expect(validateToolName('my/tool')).toBe(expected);
    expect(validateToolName('my.tool')).toBe(expected);
  });

  it('rejects a name starting with a digit or symbol', () => {
    const expected = 'Name must start with a letter.';
    expect(validateToolName('1tool')).toBe(expected);
    expect(validateToolName('-tool')).toBe(expected);
    expect(validateToolName('_tool')).toBe(expected);
  });

  it('accepts letters, digits, dashes, and underscores after a leading letter', () => {
    expect(validateToolName('my-cool_tool2')).toBeNull();
    expect(validateToolName('a')).toBeNull();
  });

  it('rejects names over 64 characters', () => {
    expect(validateToolName('a'.repeat(65))).toBe('Name must be 64 characters or fewer.');
    expect(validateToolName('a'.repeat(64))).toBeNull();
  });
});

describe('buildParametersSchema', () => {
  function row(overrides: Partial<ParamFieldRow>): ParamFieldRow {
    return { ...makeEmptyParamRow(), ...overrides };
  }

  it('assembles a string param', () => {
    const schema = buildParametersSchema([row({ name: 'query', type: 'string' })]);
    expect(schema).toEqual({
      type: 'object',
      properties: { query: { type: 'string' } },
    });
  });

  it('assembles a number param', () => {
    const schema = buildParametersSchema([row({ name: 'count', type: 'number' })]);
    expect(schema).toEqual({ type: 'object', properties: { count: { type: 'number' } } });
  });

  it('assembles a boolean param', () => {
    const schema = buildParametersSchema([row({ name: 'flag', type: 'boolean' })]);
    expect(schema).toEqual({ type: 'object', properties: { flag: { type: 'boolean' } } });
  });

  it('assembles an array param', () => {
    const schema = buildParametersSchema([row({ name: 'items', type: 'array' })]);
    expect(schema).toEqual({
      type: 'object',
      properties: { items: { type: 'array', items: {} } },
    });
  });

  it('assembles an object param', () => {
    const schema = buildParametersSchema([row({ name: 'payload', type: 'object' })]);
    expect(schema).toEqual({ type: 'object', properties: { payload: { type: 'object' } } });
  });

  it('assembles an enum param as a string type + enum keyword, dropping blank values', () => {
    const schema = buildParametersSchema([
      row({ name: 'mode', type: 'enum', enumValues: ['a', ' b ', '', 'c'] }),
    ]);
    expect(schema).toEqual({
      type: 'object',
      properties: { mode: { type: 'string', enum: ['a', 'b', 'c'] } },
    });
  });

  it('carries description through when present', () => {
    const schema = buildParametersSchema([
      row({ name: 'query', type: 'string', description: 'Search text' }),
    ]);
    expect(schema).toEqual({
      type: 'object',
      properties: { query: { type: 'string', description: 'Search text' } },
    });
  });

  it('collects required field names into a top-level required array', () => {
    const schema = buildParametersSchema([
      row({ name: 'a', type: 'string', required: true }),
      row({ name: 'b', type: 'string', required: false }),
      row({ name: 'c', type: 'number', required: true }),
    ]);
    expect(schema).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'number' } },
      required: ['a', 'c'],
    });
  });

  it('omits the required key entirely when nothing is required', () => {
    const schema = buildParametersSchema([row({ name: 'a', type: 'string', required: false })]);
    expect(schema).not.toHaveProperty('required');
  });

  it('skips rows with a blank/whitespace-only name', () => {
    const schema = buildParametersSchema([
      row({ name: '  ', type: 'string' }),
      row({ name: 'ok', type: 'string' }),
    ]);
    expect(schema).toEqual({ type: 'object', properties: { ok: { type: 'string' } } });
  });

  it('returns an empty object shape for no rows', () => {
    expect(buildParametersSchema([])).toEqual({ type: 'object', properties: {} });
  });
});

describe('parseParametersSchema (edit-mode round trip)', () => {
  it('round-trips every param type through build -> parse -> build unchanged', () => {
    const rows: ParamFieldRow[] = [
      row('query', 'string', { required: true, description: 'Search text' }),
      row('count', 'number', {}),
      row('flag', 'boolean', {}),
      row('mode', 'enum', { enumValues: ['a', 'b'] }),
      row('items', 'array', {}),
      row('payload', 'object', {}),
    ];
    const schema = buildParametersSchema(rows);
    const parsed = parseParametersSchema(schema);
    expect(buildParametersSchema(parsed)).toEqual(schema);
  });

  it('recovers enum type + values from a persisted string+enum schema', () => {
    const parsed = parseParametersSchema({
      type: 'object',
      properties: { mode: { type: 'string', enum: ['a', 'b'] } },
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ name: 'mode', type: 'enum', enumValues: ['a', 'b'] });
  });

  it('recovers the required flag from the top-level required array', () => {
    const parsed = parseParametersSchema({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a'],
    });
    expect(parsed.find((r) => r.name === 'a')?.required).toBe(true);
    expect(parsed.find((r) => r.name === 'b')?.required).toBe(false);
  });

  it('returns an empty array for null/undefined/malformed schema', () => {
    expect(parseParametersSchema(null)).toEqual([]);
    expect(parseParametersSchema(undefined)).toEqual([]);
    expect(parseParametersSchema({})).toEqual([]);
  });

  function row(name: string, type: ParamFieldRow['type'], overrides: Partial<ParamFieldRow>) {
    return { ...makeEmptyParamRow(), name, type, ...overrides };
  }
});

describe('scaffoldToolTs', () => {
  it('default-imports snaglet from @snaglet/sdk (the documented handler contract)', () => {
    const src = scaffoldToolTs('my-tool');
    expect(src).toMatch(/^import snaglet from ['"]@snaglet\/sdk['"];/m);
  });

  it('default-exports an async handler(input, context) function', () => {
    const src = scaffoldToolTs('my-tool');
    expect(src).toMatch(/export default async function handler\(input, context\)/);
  });

  it('echoes the input back in the returned object', () => {
    const src = scaffoldToolTs('my-tool');
    expect(src).toMatch(/input/);
    expect(src).toMatch(/return\s*{/);
  });

  it('names the tool in a comment so the scaffold is identifiable', () => {
    expect(scaffoldToolTs('weather-lookup')).toContain('weather-lookup');
  });
});

describe('scaffoldToolMd', () => {
  it('includes the tool name as a heading', () => {
    expect(scaffoldToolMd('my-tool', 'Does a thing')).toContain('# my-tool');
  });

  it('includes the description when given', () => {
    expect(scaffoldToolMd('my-tool', 'Does a thing')).toContain('Does a thing');
  });

  it('falls back to a placeholder when the description is blank', () => {
    expect(scaffoldToolMd('my-tool', '')).not.toBe('');
  });
});

describe('buildDefinitionJson', () => {
  it('produces valid JSON with the exact fields the server contract expects', () => {
    const json = buildDefinitionJson({
      name: 'my-tool',
      description: 'Does a thing',
      categoryPath: 'custom',
      tier: 'standard',
      keywords: ['a', 'b'],
      paramRows: [{ ...makeEmptyParamRow(), name: 'query', type: 'string', required: true }],
    });
    const parsed = JSON.parse(json);
    expect(parsed).toEqual({
      name: 'my-tool',
      description: 'Does a thing',
      categoryPath: 'custom',
      providerId: null,
      tier: 'standard',
      parametersSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      keywords: ['a', 'b'],
    });
  });

  it('defaults categoryPath to "custom" when blank', () => {
    const json = buildDefinitionJson({
      name: 'my-tool',
      description: '',
      categoryPath: '  ',
      tier: 'standard',
      keywords: [],
      paramRows: [],
    });
    expect(JSON.parse(json).categoryPath).toBe(DEFAULT_CATEGORY_PATH);
  });

  it('always sets providerId to null — derived server-side, never a form input', () => {
    const json = buildDefinitionJson({
      name: 'my-tool',
      description: '',
      categoryPath: 'custom',
      tier: 'core',
      keywords: [],
      paramRows: [],
    });
    expect(JSON.parse(json).providerId).toBeNull();
  });
});

describe('parseDefinition (edit-mode metadata round trip)', () => {
  it('recovers name/description/categoryPath/tier/keywords/paramRows from a definition object', () => {
    const definition = {
      name: 'my-tool',
      description: 'Does a thing',
      categoryPath: 'custom',
      providerId: null,
      tier: 'core',
      parametersSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      keywords: ['a', 'b'],
    };
    const form = parseDefinition(definition);
    expect(form.name).toBe('my-tool');
    expect(form.description).toBe('Does a thing');
    expect(form.categoryPath).toBe('custom');
    expect(form.tier).toBe('core');
    expect(form.keywords).toEqual(['a', 'b']);
    expect(form.paramRows).toHaveLength(1);
    expect(form.paramRows[0]).toMatchObject({ name: 'query', type: 'string', required: true });
  });

  it('falls back to safe defaults for a sparse/malformed definition', () => {
    const form = parseDefinition({});
    expect(form.name).toBe('');
    expect(form.description).toBe('');
    expect(form.categoryPath).toBe(DEFAULT_CATEGORY_PATH);
    expect(form.tier).toBe('standard');
    expect(form.keywords).toEqual([]);
    expect(form.paramRows).toEqual([]);
  });

  it('round-trips a full definition.json through parseDefinition -> buildDefinitionJson unchanged', () => {
    const definition = {
      name: 'my-tool',
      description: 'Does a thing',
      categoryPath: 'custom',
      providerId: null,
      tier: 'core',
      parametersSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text' },
          mode: { type: 'string', enum: ['a', 'b'] },
        },
        required: ['query'],
      },
      keywords: ['a', 'b'],
    };
    const roundTripped = JSON.parse(buildDefinitionJson(parseDefinition(definition)));
    expect(roundTripped).toEqual(definition);
  });

  it('leaves unrepresentableSchema unset (null) for a schema the row editor can fully represent', () => {
    const form = parseDefinition({
      name: 'my-tool',
      tier: 'standard',
      parametersSchema: { type: 'object', properties: { a: { type: 'string' } } },
    });
    expect(form.unrepresentableSchema).toBeNull();
  });
});

describe('isSchemaRepresentable / unrepresentable-schema degrade path', () => {
  it('is true for an absent/empty schema, including a bare {} with no type/properties', () => {
    expect(isSchemaRepresentable(null)).toBe(true);
    expect(isSchemaRepresentable(undefined)).toBe(true);
    expect(isSchemaRepresentable({})).toBe(true);
    expect(isSchemaRepresentable({ type: 'object', properties: {} })).toBe(true);
  });

  it('treats required: [] and an absent required as equivalent — not a false degrade', () => {
    expect(
      isSchemaRepresentable({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: [],
      })
    ).toBe(true);
  });

  it('is false for a non-object root type', () => {
    expect(isSchemaRepresentable({ type: 'array', items: { type: 'string' } })).toBe(false);
  });

  it('is false for an unmodeled root-level keyword (e.g. additionalProperties)', () => {
    expect(
      isSchemaRepresentable({
        type: 'object',
        properties: {},
        additionalProperties: false,
      })
    ).toBe(false);
  });

  it('is false for a present-but-malformed properties (null / scalar / array) — not silently equal-to-empty', () => {
    expect(isSchemaRepresentable({ type: 'object', properties: null })).toBe(false);
    expect(isSchemaRepresentable({ type: 'object', properties: 'garbage' })).toBe(false);
    expect(isSchemaRepresentable({ type: 'object', properties: [] })).toBe(false);
  });

  it('is false for a malformed non-array required', () => {
    expect(
      isSchemaRepresentable({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: 'a',
      })
    ).toBe(false);
  });

  it('is true for every schema shape the row editor can produce', () => {
    const schema = buildParametersSchema([
      { ...makeEmptyParamRow(), name: 'query', type: 'string', required: true },
      { ...makeEmptyParamRow(), name: 'count', type: 'number' },
      { ...makeEmptyParamRow(), name: 'mode', type: 'enum', enumValues: ['a', 'b'] },
      { ...makeEmptyParamRow(), name: 'items', type: 'array' },
    ]);
    expect(isSchemaRepresentable(schema)).toBe(true);
  });

  it('is false for a typed array items schema — the editor always writes items: {}', () => {
    expect(
      isSchemaRepresentable({
        type: 'object',
        properties: { tags: { type: 'array', items: { type: 'string' } } },
      })
    ).toBe(false);
  });

  it('is false for nested object properties', () => {
    expect(
      isSchemaRepresentable({
        type: 'object',
        properties: {
          address: {
            type: 'object',
            properties: { city: { type: 'string' } },
          },
        },
      })
    ).toBe(false);
  });

  it('is false for a keyword the row model has no field for (e.g. pattern)', () => {
    expect(
      isSchemaRepresentable({
        type: 'object',
        properties: { code: { type: 'string', pattern: '^[A-Z]+$' } },
      })
    ).toBe(false);
  });

  it('is false for a non-string enum', () => {
    expect(
      isSchemaRepresentable({
        type: 'object',
        properties: { level: { type: 'number', enum: [1, 2, 3] } },
      })
    ).toBe(false);
  });

  it('parseDefinition degrades gracefully: empty paramRows + the raw schema carried through untouched', () => {
    const unrepresentable = {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
    };
    const form = parseDefinition({
      name: 'my-tool',
      tier: 'standard',
      parametersSchema: unrepresentable,
    });
    expect(form.paramRows).toEqual([]);
    expect(form.unrepresentableSchema).toEqual(unrepresentable);
  });

  it('buildDefinitionJson writes an unrepresentableSchema verbatim, ignoring paramRows', () => {
    const unrepresentable = {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
    };
    const json = buildDefinitionJson({
      name: 'my-tool',
      description: '',
      categoryPath: 'custom',
      tier: 'standard',
      keywords: [],
      // A stray row here must NOT leak into the output — the raw schema wins.
      paramRows: [{ ...makeEmptyParamRow(), name: 'stray', type: 'string' }],
      unrepresentableSchema: unrepresentable,
    });
    expect(JSON.parse(json).parametersSchema).toEqual(unrepresentable);
  });

  it("editing metadata around an unrepresentable schema doesn't destroy it — full save round trip", () => {
    const original = {
      name: 'my-tool',
      description: 'Old description',
      categoryPath: 'custom',
      providerId: null,
      tier: 'standard',
      parametersSchema: {
        type: 'object',
        properties: { tags: { type: 'array', items: { type: 'string' } } },
      },
      keywords: [],
    };
    const form = parseDefinition(original);
    const edited = { ...form, description: 'New description' };
    const saved = JSON.parse(buildDefinitionJson(edited));
    expect(saved.description).toBe('New description');
    expect(saved.parametersSchema).toEqual(original.parametersSchema);
  });
});

describe('toolIdFromSource', () => {
  it('extracts the workspace folder id from a workspace: source', () => {
    expect(toolIdFromSource('workspace:my-tool')).toBe('my-tool');
  });

  it('returns null for a non-workspace source (builtin/mcp) or a missing source', () => {
    expect(toolIdFromSource(null)).toBeNull();
    expect(toolIdFromSource(undefined)).toBeNull();
    expect(toolIdFromSource('mcp:notion')).toBeNull();
  });
});

describe('formatDeployFailure', () => {
  it('includes both the one-line summary AND the full output when they differ', () => {
    const text = formatDeployFailure({
      step: 'install',
      error: 'pnpm install exited with code 1',
      output: 'ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/left-pad-9000 - Not Found - 404',
    });
    expect(text).toContain('Install failed: pnpm install exited with code 1');
    expect(text).toContain('ERR_PNPM_FETCH_404');
  });

  it('labels a build-step failure "Build failed"', () => {
    const text = formatDeployFailure({
      step: 'build',
      error: 'tool.ts:3:1 Unexpected token',
      output: 'esbuild output',
    });
    expect(text).toContain('Build failed: tool.ts:3:1 Unexpected token');
    expect(text).toContain('esbuild output');
  });

  it('falls back to "Unknown error" when `error` is absent', () => {
    const text = formatDeployFailure({ step: 'install', output: 'some output' });
    expect(text).toContain('Install failed: Unknown error');
    expect(text).toContain('some output');
  });

  it('does not duplicate the summary when output is empty or identical to it', () => {
    expect(formatDeployFailure({ step: 'install', error: 'boom', output: '' })).toBe(
      'Install failed: boom'
    );
    expect(formatDeployFailure({ step: 'install', error: 'boom', output: 'boom' })).toBe(
      'Install failed: boom'
    );
  });
});

describe('TOOL_TIERS', () => {
  it('is exactly the real ToolModel tier enum — core and standard', () => {
    expect(TOOL_TIERS).toEqual(['core', 'standard']);
  });
});
