/**
 * POST /api/tools/execute/test really bundles and runs unsaved tool code: real
 * esbuild, real node, and the vendored @snaglet/sdk a deployed tool gets, written
 * as the sandbox module. Pins that the runner starts (it once exited with
 * ERR_INPUT_TYPE_NOT_ALLOWED before loading anything) and that the SDK's
 * exports resolve under Test. The tool makes no server call, so no Snaglet server
 * is needed.
 */

// esbuild comes from the repo's own install (npx finds it on PATH), never a
// login shell lookup or the network.
jest.mock('@server/services/ToolService/lib/loginShellPath', () => {
  const { delimiter, resolve } = jest.requireActual<typeof import('node:path')>('node:path');
  const bin = resolve(process.cwd(), 'node_modules', '.bin');
  return {
    resolveLoginShellPath: () => Promise.resolve(),
    shellPath: () => `${bin}${delimiter}${process.env.PATH ?? ''}`,
  };
});

import express from 'express';
import request from 'supertest';
import { errorHandler } from '@server/middleware';
import executionRoutes from '@server/domains/tools/routes/execution.routes';
import { HOOK_EVENT_NAMES } from '@server/services/ToolService/customTools/vendorSdk';

const CODE = `
import snaglet, { defineHook, HOOK_EVENT_NAMES } from '@snaglet/sdk';

export default async function handler() {
  return {
    events: HOOK_EVENT_NAMES.length,
    defineHook: typeof defineHook,
    surface: [snaglet.tables.read, snaglet.parseContent, snaglet.hooks.run, snaglet.emit, snaglet.tools.execute].map(
      (member) => typeof member
    ),
  };
}
`;

describe('POST /api/tools/execute/test — real esbuild and node', () => {
  it('runs unsaved code against the deployed @snaglet/sdk', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/tools', executionRoutes);
    app.use(errorHandler);

    const res = await request(app).post('/api/tools/execute/test').send({ code: CODE });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(expect.objectContaining({ success: true }));
    expect(JSON.parse(res.body.data.output)).toEqual({
      events: HOOK_EVENT_NAMES.length,
      defineHook: 'function',
      surface: ['function', 'function', 'function', 'function', 'function'],
    });
  }, 60_000);
});
