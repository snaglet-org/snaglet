import { describe, expect, it } from 'vitest';
import {
  explainNestedToolRefusal,
  seedArgsFromSchema,
  seedArgsJson,
} from './toolTestConsoleSupport';

describe('seedArgsFromSchema', () => {
  it('seeds defaults, first enum value, and empty-by-type placeholders', () => {
    expect(
      seedArgsFromSchema({
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', default: 10 },
          mode: { type: 'string', enum: ['fast', 'slow'] },
          exact: { type: 'boolean' },
          tags: { type: 'array', items: {} },
          options: { type: 'object' },
          count: { type: 'integer' },
        },
        required: ['query'],
      })
    ).toEqual({
      query: '',
      limit: 10,
      mode: 'fast',
      exact: false,
      tags: [],
      options: {},
      count: 0,
    });
  });

  it('returns an empty object for an absent or malformed schema', () => {
    expect(seedArgsFromSchema(null)).toEqual({});
    expect(seedArgsFromSchema(undefined)).toEqual({});
    expect(seedArgsFromSchema({ type: 'object', properties: [] as unknown as never })).toEqual({});
  });

  it('pretty-prints through seedArgsJson', () => {
    expect(seedArgsJson({ type: 'object', properties: { q: { type: 'string' } } })).toBe(
      JSON.stringify({ q: '' }, null, 2)
    );
  });
});

// What the sandbox's @snaglet/sdk (the deployed runtime) throws on a refused call.
const POLICY_REFUSAL =
  'Snaglet server returned 403: {"success":false,"error":{"code":"FORBIDDEN","message":' +
  '"Blocked by tool-access policy: `shell` is not in this agent\'s tool list."}}';

describe('explainNestedToolRefusal', () => {
  it("explains a nested call ghost's allow list refuses", () => {
    const note = explainNestedToolRefusal(POLICY_REFUSAL);
    expect(note).toMatch(/test runs act as the ghost system actor/i);
    // Names ghost's allow list and the tools every allow list keeps.
    for (const tool of [
      'table',
      'thread_send',
      'thread_read',
      'database_query',
      'get_current_datetime',
    ]) {
      expect(note).toContain(tool);
    }
    expect(note).toMatch(/when an agent calls it, it uses that agent's own tool access/i);
  });

  it('explains the refusal wherever it sits in the text (snaglet.tables.read wraps it too)', () => {
    expect(explainNestedToolRefusal(`Error: ${POLICY_REFUSAL}`)).toMatch(
      /test runs act as the ghost system actor/i
    );
    expect(
      explainNestedToolRefusal(
        'snaglet.tools.execute("shell") failed: Blocked by tool-access policy: `shell` is not in this agent\'s tool list.'
      )
    ).toMatch(/test runs act as the ghost system actor/i);
  });

  it('leaves unrelated errors untranslated', () => {
    expect(explainNestedToolRefusal('TypeError: fetch failed')).toBeNull();
    expect(explainNestedToolRefusal('Build failed:\nUnexpected token')).toBeNull();
  });
});
