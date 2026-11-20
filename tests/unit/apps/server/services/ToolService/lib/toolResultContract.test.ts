import { describe, test, expect } from '@jest/globals';
import {
  buildExampleCall,
  extractRequiredParams,
  wrapToolResult,
  wrapToolResults,
} from '@server/services/ToolService/lib/toolResultContract';

describe('toolResultContract — extractRequiredParams', () => {
  test('returns [] for null/undefined/empty schemas', () => {
    expect(extractRequiredParams(null)).toEqual([]);
    expect(extractRequiredParams(undefined)).toEqual([]);
    expect(extractRequiredParams({})).toEqual([]);
  });

  test('returns [] when required is missing or wrong type', () => {
    expect(extractRequiredParams({ properties: { x: {} } })).toEqual([]);
    expect(extractRequiredParams({ required: 'not-an-array' })).toEqual([]);
    expect(extractRequiredParams({ required: 42 })).toEqual([]);
  });

  test('filters non-string entries from required', () => {
    expect(extractRequiredParams({ required: ['a', 1, null, 'b', undefined, 'c'] })).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  test('returns the full required array when well-formed', () => {
    expect(extractRequiredParams({ required: ['query', 'limit'] })).toEqual(['query', 'limit']);
  });
});

describe('toolResultContract — buildExampleCall', () => {
  test('emits empty params when no required fields', () => {
    expect(buildExampleCall('list_tools', {})).toEqual({
      tool: 'list_tools',
      params: {},
    });
  });

  test('typed placeholders for primitive properties', () => {
    const example = buildExampleCall('demo', {
      required: ['s', 'n', 'b', 'a', 'o'],
      properties: {
        s: { type: 'string' },
        n: { type: 'number' },
        b: { type: 'boolean' },
        a: { type: 'array' },
        o: { type: 'object' },
      },
    });
    expect(example).toEqual({
      tool: 'demo',
      params: {
        s: '<string>',
        n: 0,
        b: false,
        a: [],
        o: {},
      },
    });
  });

  test('falls back to <value> for unknown / missing types', () => {
    const example = buildExampleCall('demo', {
      required: ['x', 'y'],
      properties: { x: { type: 'unknown-type' } },
    });
    expect(example.params).toEqual({ x: '<value>', y: '<value>' });
  });

  test('omits non-required params from example', () => {
    const example = buildExampleCall('demo', {
      required: ['a'],
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
      },
    });
    expect(example.params).toEqual({ a: '<string>' });
    expect(Object.keys(example.params)).not.toContain('b');
  });
});

describe('toolResultContract — wrapToolResult', () => {
  test('produces a fully-formed contract for a typical search hit', () => {
    const wrapped = wrapToolResult({
      id: 'tool',
      name: 'Search Tools',
      description: 'Find tools by keyword.',
      keywords: ['discovery'],
      aliases: ['search', 'find'],
      parameters_schema: {
        type: 'object',
        required: ['query'],
        properties: { query: { type: 'string' } },
      },
    });

    expect(wrapped.callable).toBe(true);
    expect(wrapped.invoke).toEqual({
      via: 'action',
      tool: 'tool',
      params_shape: 'object',
    });
    expect(wrapped.required_params).toEqual(['query']);
    expect(wrapped.example_call).toEqual({
      tool: 'tool',
      params: { query: '<string>' },
    });
    expect(wrapped.aliases).toEqual(['search', 'find']);
  });

  test('safe on partial records — missing optional fields stay undefined, not fabricated', () => {
    const wrapped = wrapToolResult({ id: 'bare_tool' });
    expect(wrapped.id).toBe('bare_tool');
    expect(wrapped.name).toBe('bare_tool'); // falls back to id
    expect(wrapped.description).toBe('');
    expect(wrapped.required_params).toEqual([]);
    expect(wrapped.example_call).toEqual({ tool: 'bare_tool', params: {} });
    expect(wrapped.callable).toBe(true);
    expect(wrapped.aliases).toBeUndefined();
    expect(wrapped.keywords).toBeUndefined();
  });

  test('null aliases/keywords are coerced to undefined, not preserved as null', () => {
    const wrapped = wrapToolResult({
      id: 't',
      aliases: null as unknown as string[],
      keywords: null as unknown as string[],
      parameters_schema: null,
    });
    expect(wrapped.aliases).toBeUndefined();
    expect(wrapped.keywords).toBeUndefined();
    expect(wrapped.parameters_schema).toBeUndefined();
    expect(wrapped.required_params).toEqual([]);
  });

  test('invoke.tool always equals id, even when name differs', () => {
    const wrapped = wrapToolResult({
      id: 'canonical_id',
      name: 'Pretty Display Name',
    });
    expect(wrapped.invoke.tool).toBe('canonical_id');
    expect(wrapped.example_call.tool).toBe('canonical_id');
  });
});

describe('toolResultContract — wrapToolResults', () => {
  test('maps every entry through wrapToolResult', () => {
    const out = wrapToolResults([{ id: 'a' }, { id: 'b' }]);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('a');
    expect(out[1].id).toBe('b');
    expect(out.every((t) => t.callable === true)).toBe(true);
  });
});
