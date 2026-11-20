import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { toolsApi, toolWorkspacesApi } from './tools';
import { setPanelToken } from '../panelToken';

afterEach(() => {
  vi.unstubAllGlobals();
  setPanelToken(null);
});

function stubFetchOk() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      success: true,
      data: { success: true, output: 'ok', durationMs: 1 },
    }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('toolsApi.execute', () => {
  it('POSTs {name, input} with no act_as_agent_id key when no act-as option is given', async () => {
    const fetchMock = stubFetchOk();

    await toolsApi.execute('echo_tool', { a: 1 });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({ name: 'echo_tool', input: { a: 1 } });
  });

  it('includes act_as_agent_id when actAsAgentId is provided (panel act-as picker)', async () => {
    const fetchMock = stubFetchOk();

    await toolsApi.execute('memory_store', { content: 'x' }, { actAsAgentId: 'agent-1' });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({
      name: 'memory_store',
      input: { content: 'x' },
      act_as_agent_id: 'agent-1',
    });
  });

  it('sends no X-Snaglet-Panel-Token header when no panel token has been delivered yet', async () => {
    const fetchMock = stubFetchOk();

    await toolsApi.execute('echo_tool', {});

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
    });
  });

  it('attaches X-Snaglet-Panel-Token once a panel token has been delivered (Tauri init script or the dev-mode WebSocket push)', async () => {
    setPanelToken('the-panel-token');
    const fetchMock = stubFetchOk();

    await toolsApi.execute('echo_tool', {});

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Snaglet-Panel-Token': 'the-panel-token',
    });
  });
});

describe('toolsApi.test', () => {
  it('attaches X-Snaglet-Panel-Token to the sandboxed test-run route too — same enforcement as execute', async () => {
    setPanelToken('the-panel-token');
    const fetchMock = stubFetchOk();

    await toolsApi.test('export default async () => "hi";', {});

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Snaglet-Panel-Token': 'the-panel-token',
    });
  });
});

// The deploy route (apps/server/src/domains/tools/routes/workspaces.routes.ts)
// intentionally responds HTTP 200 with an envelope-level `success: false` when
// the install/build step fails — that's a legitimate business outcome (a bad
// tool.ts), not a transport failure, and the detail (`step`/`output`/`error`)
// lives in the envelope's `data`, not the generic `error`/`message` fields
// `fetchData` looks at. `fetchData` would collapse this into a content-free
// "Request failed", so `deploy` must read the envelope directly to give the
// tool-builder panel the real error to show.
describe('toolWorkspacesApi.deploy', () => {
  function stubFetch(body: unknown) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => body,
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('resolves the full success payload when install + build + activate succeed', async () => {
    stubFetch({
      success: true,
      timestamp: '2026-07-16T00:00:00Z',
      data: {
        tool: { id: 'my_tool', name: 'my-tool' },
        install: { success: true, output: '', durationMs: 5 },
        build: { success: true, output: '', durationMs: 10 },
      },
    });

    const result = await toolWorkspacesApi.deploy('my-tool');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.tool).toEqual({ id: 'my_tool', name: 'my-tool' });
    }
  });

  it('resolves (does not throw) with the real build error when the build step fails', async () => {
    stubFetch({
      success: false,
      timestamp: '2026-07-16T00:00:00Z',
      data: {
        step: 'build',
        success: false,
        output: 'esbuild error output',
        error: 'tool.ts:3:1 Unexpected token',
        durationMs: 42,
      },
    });

    const result = await toolWorkspacesApi.deploy('my-tool');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.step).toBe('build');
      expect(result.error).toBe('tool.ts:3:1 Unexpected token');
      expect(result.output).toBe('esbuild error output');
    }
  });

  it('resolves with the real install error when the install step fails', async () => {
    stubFetch({
      success: false,
      timestamp: '2026-07-16T00:00:00Z',
      data: {
        step: 'install',
        success: false,
        output: '',
        error: 'pnpm install exited with code 1',
        durationMs: 7,
      },
    });

    const result = await toolWorkspacesApi.deploy('my-tool');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.step).toBe('install');
      expect(result.error).toBe('pnpm install exited with code 1');
    }
  });

  it('still throws on a genuine transport failure (non-2xx response)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(toolWorkspacesApi.deploy('my-tool')).rejects.toThrow();
  });
});
