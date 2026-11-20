import { extractActionParams } from '@server/services/ToolService/lib/extractActionParams';

describe('extractActionParams', () => {
  it('returns the nested params object when present', () => {
    expect(extractActionParams({ tool: 'file_read', params: { path: '/a' } })).toEqual({
      path: '/a',
    });
  });

  it('parses a JSON-string params payload', () => {
    expect(
      extractActionParams({ tool: 'file_read', params: JSON.stringify({ path: '/a' }) })
    ).toEqual({ path: '/a' });
  });

  it('falls back to flattened top-level keys when the params JSON string is malformed', () => {
    expect(
      extractActionParams({ tool: 'file_read', params: '{not valid json', path: '/a' })
    ).toEqual({ path: '/a' });
  });

  it('falls back to flattened top-level keys when params is absent', () => {
    expect(extractActionParams({ tool: 'file_write', path: '/a', content: 'hi' })).toEqual({
      path: '/a',
      content: 'hi',
    });
  });

  it('strips proxy control fields (tool, tool_name, params) from flattened args', () => {
    expect(
      extractActionParams({ tool: 'shell_exec', tool_name: 'shell_exec', command: 'ls' })
    ).toEqual({ command: 'ls' });
  });

  // The mixed shape: nested `params` is non-empty and a large arg is
  // flattened to the top level. Both must survive, or agents see
  // "content is required" / "path is required" on big payloads.
  it('merges flattened top-level args with a non-empty nested params object', () => {
    const bigContent = 'x'.repeat(10_000);
    expect(
      extractActionParams({
        tool: 'file_write',
        params: { path: '/big.ts' },
        content: bigContent,
      })
    ).toEqual({ path: '/big.ts', content: bigContent });
  });

  it('lets nested params win on key collision with a flattened key', () => {
    expect(
      extractActionParams({
        tool: 'file_write',
        params: { path: '/nested' },
        path: '/flattened',
      })
    ).toEqual({ path: '/nested' });
  });

  it('returns an empty object when only control fields are present', () => {
    expect(extractActionParams({ tool: 'noop' })).toEqual({});
  });
});
