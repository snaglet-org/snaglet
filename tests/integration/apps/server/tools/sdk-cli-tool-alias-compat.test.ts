import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { snaglet } from '../../../../../packages/snaglet-sdk/src';

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

describe('SDK and CLI tool-id compatibility', () => {
  let server: http.Server;
  let serverUrl: string;
  let received: CapturedRequest[] = [];
  let originalServerUrl: string | undefined;
  let originalToolContext: string | undefined;
  let cliRuntimeUrl: string;

  beforeAll(async () => {
    originalServerUrl = process.env.SNAGLET_SERVER_URL;
    originalToolContext = process.env.SNAGLET_TOOL_CONTEXT_JSON;

    server = http.createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        received.push({ url: req.url ?? '', body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            data: {
              success: true,
              output: JSON.stringify({ accepted: body.name }),
              durationMs: 1,
            },
          })
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const { port } = server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${port}`;
    process.env.SNAGLET_SERVER_URL = serverUrl;
    process.env.SNAGLET_TOOL_CONTEXT_JSON = JSON.stringify({ agentId: 'agent-sdk-compat' });

    cliRuntimeUrl = pathToFileURL(
      path.resolve(process.cwd(), 'packages/snaglet-cli/src/sdk-runtime.mjs')
    ).href;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalServerUrl === undefined) delete process.env.SNAGLET_SERVER_URL;
    else process.env.SNAGLET_SERVER_URL = originalServerUrl;
    if (originalToolContext === undefined) delete process.env.SNAGLET_TOOL_CONTEXT_JSON;
    else process.env.SNAGLET_TOOL_CONTEXT_JSON = originalToolContext;
  });

  beforeEach(() => {
    received = [];
  });

  async function runCliProxyCalls(): Promise<unknown> {
    const source = `
      const { tools } = await import(${JSON.stringify(cliRuntimeUrl)});
      const canonical = await tools.search({ query: 'roadmap', kind: 'workspace' });
      const legacy = await tools.workspace_search({ query: 'roadmap' });
      console.log(JSON.stringify({ canonical, legacy }));
    `;
    return new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        ['--input-type=module', '--eval', source],
        {
          cwd: process.cwd(),
          env: { ...process.env, SNAGLET_SERVER_URL: serverUrl },
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`CLI runtime failed: ${stderr || error.message}`));
            return;
          }
          resolve(JSON.parse(stdout.trim()));
        }
      );
    });
  }

  it('CLI tools.<name> forwards canonical and legacy ids unchanged for server resolution', async () => {
    await expect(runCliProxyCalls()).resolves.toEqual({
      canonical: { accepted: 'search' },
      legacy: { accepted: 'workspace_search' },
    });

    expect(received).toEqual([
      {
        url: '/api/tools/execute',
        body: {
          name: 'search',
          input: { query: 'roadmap', kind: 'workspace' },
        },
      },
      {
        url: '/api/tools/execute',
        body: {
          name: 'workspace_search',
          input: { query: 'roadmap' },
        },
      },
    ]);
  });

  it('snaglet.tools.execute retains intentional old-id compatibility', async () => {
    const result = await snaglet.tools.execute('memory_store', {
      content: 'legacy note',
    });

    expect(JSON.parse(result.output)).toEqual({ accepted: 'memory_store' });
    expect(received).toEqual([
      {
        url: '/api/tools/execute',
        body: {
          name: 'memory_store',
          input: { content: 'legacy note' },
          agent_id: 'agent-sdk-compat',
        },
      },
    ]);
  });
});
