/**
 * `snaglet.tables.read` in the vendored `@snaglet/sdk` runtime that hooks and workspace
 * tools are built against: it runs `table` with op read through
 * /api/tools/execute and hands back `{ rows, fields, text }`, where `text` is
 * the tool's unchanged output. A text-only read has empty rows and fields; a
 * failed read throws.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { SDK_RUNTIME_SOURCE } from '@server/services/ToolService/customTools/vendorSdk';

interface Sdk {
  tables: {
    read(input: Record<string, unknown>): Promise<{
      rows: Record<string, unknown>[];
      fields: string[];
      text: string;
    }>;
  };
}

type FetchStub = jest.Mock<
  (url: string, init: { body: string }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>
>;

/** The runtime is ESM text; evaluate it with its exports stripped and a stub fetch. */
function loadSdk(fetchImpl: FetchStub): Sdk {
  const source = SDK_RUNTIME_SOURCE.replace('export const snaglet =', 'const snaglet =')
    .replace('export function defineHook', 'function defineHook')
    .replace('export const HOOK_EVENT_NAMES', 'const HOOK_EVENT_NAMES')
    .replace('export default snaglet;', '');
  return (new Function('fetch', `${source}\nreturn snaglet;`) as (f: FetchStub) => Sdk)(fetchImpl);
}

function respondWith(data: unknown): FetchStub {
  return jest.fn(async () => ({ ok: true, json: async () => ({ success: true, data }) }));
}

const TSV = 'status\tphase\nDone\t2\n1 row';

beforeEach(() => {
  process.env.SNAGLET_SERVER_URL = 'http://127.0.0.1:4999';
  process.env.SNAGLET_TOOL_CONTEXT_JSON = JSON.stringify({ agentId: 'test-agent-a' });
});

afterEach(() => {
  delete process.env.SNAGLET_SERVER_URL;
  delete process.env.SNAGLET_TOOL_CONTEXT_JSON;
});

describe('vendored snaglet.tables.read', () => {
  it('reads through the table tool and returns rows, fields and the same text', async () => {
    const fetchImpl = respondWith({
      success: true,
      output: TSV,
      durationMs: 3,
      rawContent: { fields: ['status', 'phase'], rows: [{ status: 'Done', phase: 2 }] },
    });

    const result = await loadSdk(fetchImpl).tables.read({ sql: 'SELECT status, phase FROM t' });

    expect(result).toEqual({
      rows: [{ status: 'Done', phase: 2 }],
      fields: ['status', 'phase'],
      text: TSV,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4999/api/tools/execute');
    expect(JSON.parse(init.body)).toEqual({
      name: 'table',
      input: { sql: 'SELECT status, phase FROM t', op: 'read' },
      agent_id: 'test-agent-a',
    });
  });

  it('a text-only read (a table field list) has no rows', async () => {
    const result = await loadSdk(
      respondWith({ success: true, output: 'work_loop (3 rows)', durationMs: 1 })
    ).tables.read({ table: 'work_loop' });

    expect(result).toEqual({ rows: [], fields: [], text: 'work_loop (3 rows)' });
  });

  it('throws when the read fails', async () => {
    const sdk = loadSdk(
      respondWith({
        success: false,
        output: '',
        error: 'error 400: no table "nope"',
        durationMs: 1,
      })
    );

    await expect(sdk.tables.read({ table: 'nope', ids: [] })).rejects.toThrow(
      'table read failed: error 400: no table "nope"'
    );
  });
});
