/**
 * The screenshot tool and the tool editor's Test run `npx <name>`, and npx runs whatever
 * binary of that name it finds first on PATH or in a local node_modules/.bin, places an
 * agent can write to with its shell. Those children get the scrubbed command env, never the
 * server's own (session and panel tokens, provider keys, database credentials).
 */
import { EventEmitter } from 'events';
import express from 'express';
import request from 'supertest';

interface Call {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv | undefined;
}
const calls: Call[] = [];

jest.mock('child_process', () => {
  const actual = jest.requireActual<typeof import('child_process')>('child_process');
  /** A child that fails at once, so the caller takes its error path. */
  const failingChild = () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { write: () => true, end: () => undefined },
      kill: () => true,
    });
    setImmediate(() => child.emit('close', 1));
    return child;
  };
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, env: options?.env });
      return failingChild();
    },
    execFile: (
      command: string,
      args: readonly string[],
      options: { env?: NodeJS.ProcessEnv } | undefined,
      callback?: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      calls.push({ command, args, env: options?.env });
      callback?.(new Error('not available in tests'), '', '');
      return failingChild();
    },
  };
});
jest.mock('@snaglet/db/tables/images', () => ({ Images: {} }));
jest.mock('@snaglet/db/tables/tools', () => ({ Tools: { findById: jest.fn() } }));
jest.mock('@snaglet/db/tables/agents', () => ({ Agents: { findById: jest.fn() } }));
jest.mock('@server/realtime/surfaces/tree', () => ({
  emitTreeNodeCreated: jest.fn(),
  snapshotFromImage: jest.fn(),
}));
jest.mock('@server/services/ToolService/lib/resolveAgentImageContainer', () => ({
  resolveAgentImageContainer: jest.fn(),
}));
jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    isLoaded: true,
    size: 0,
    load: jest.fn(async () => undefined),
    getHandler: () => undefined,
    getDefinition: () => undefined,
    getToolIds: () => [],
  },
}));

import screenshot from '@server/services/ToolService/tools/web/screenshot/tool';
import executionRoutes from '@server/domains/tools/routes/execution.routes';

const SECRETS: Record<string, string> = {
  SNAGLET_AUTH_TOKEN: 'test-auth-token-aaaaaaaa',
  SNAGLET_PANEL_TOKEN: 'test-panel-token-aaaaaaaa',
  ANTHROPIC_API_KEY: 'test-provider-key-aaaaaaaa',
  GH_TOKEN: 'test-gh-token-aaaaaaaa',
};
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [key, value] of Object.entries(SECRETS)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
beforeEach(() => {
  calls.length = 0;
});

function npxEnv(): NodeJS.ProcessEnv {
  const npx = calls.find((c) => c.command === 'npx');
  expect(npx).toBeDefined();
  expect(npx?.env).toBeDefined();
  return npx?.env ?? {};
}

function expectScrubbed(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(SECRETS)) expect(env[key]).toBeUndefined();
  expect(env.PATH).toBeTruthy();
  expect(env.HOME).toBe(process.env.HOME);
}

describe('npx children', () => {
  it('the screenshot tool runs npx playwright without the server secrets', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('<title>Example</title><p>hello</p>'));
    await screenshot({ url: 'https://example.com/' }, {});
    fetchMock.mockRestore();
    expect(calls.find((c) => c.command === 'npx')?.args).toContain('playwright');
    expectScrubbed(npxEnv());
  });

  it("the tool editor's Test bundles with npx esbuild without the server secrets", async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/tools', executionRoutes);
    const res = await request(app)
      .post('/api/tools/execute/test')
      .send({ code: 'export default async () => "ok";', input: {} });
    expect(res.status).toBe(200);
    expect(calls.find((c) => c.command === 'npx')?.args).toContain('esbuild');
    expectScrubbed(npxEnv());
  });
});
