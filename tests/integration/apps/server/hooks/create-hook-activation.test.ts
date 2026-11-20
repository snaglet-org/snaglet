/**
 * Activation contract for agent-authored hooks (`hook(op:create)`). The tool
 * lets an agent write executable lifecycle code, and "disabled" does not mean
 * "cannot run":
 *
 *   disabled  ⇒ never runs from a lifecycle event or schedule
 *   disabled  ⇒ an explicit on-demand test run is still allowed
 *   enabling  ⇒ a human action, and the only way onto the automatic path
 *
 * The tests drive the real scanner over the real scaffold output so the tool
 * description stays true. A hook registered enabled would let an agent's code
 * fire on `message:create`, including messages it generates itself.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import { getDb } from '@snaglet/db';
import { hooks } from '@server/services/HookService';
import { HookRegistryService } from '@server/services/customHooks/HookRegistryService';
import { writeHookScaffold } from '@server/services/ToolService/handlers/hooks/scaffold';

jest.setTimeout(60_000);

describe('hook(op:create) activation contract', () => {
  let hooksRoot: string;
  let server: http.Server;
  let serverUrl: string;
  let logCalls: string[] = [];

  beforeAll(async () => {
    hooksRoot = await mkdtemp(path.join(tmpdir(), 'snaglet-create-hook-activation-'));
    getDb();

    // The generated scaffold's only side effect is snaglet.log.info, which the
    // vendored SDK POSTs here — so "did the hook body run?" is observable
    // without changing what hook(op:create) actually writes.
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        if ((req.url ?? '').includes('/log')) logCalls.push(raw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { success: true, output: 'ok' } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(hooksRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    logCalls = [];
  });

  function newRegistry(): HookRegistryService {
    return new HookRegistryService({
      dir: hooksRoot,
      serverUrl,
      hookTimeoutMs: 15_000,
      describeTimeoutMs: 15_000,
      concurrency: 2,
    });
  }

  async function scaffoldAndRegister(name: string): Promise<HookRegistryService> {
    await writeHookScaffold(hooksRoot, {
      name,
      description: 'Scaffolded by the activation contract test.',
      events: ['message:create'],
    });
    const registry = newRegistry();
    await registry.registerHookFolder(name);
    return registry;
  }

  const rowFor = async (registry: HookRegistryService, name: string) =>
    (await registry.listRegistrations()).find((item) => item.name === name);

  it('registers a scaffolded hook as built-and-ready but disabled', async () => {
    const registry = await scaffoldAndRegister('agent-authored');
    try {
      expect(await rowFor(registry, 'agent-authored')).toMatchObject({
        enabled: false,
        buildStatus: 'ready',
      });
    } finally {
      registry.stop();
    }
  });

  it('does not run a disabled hook when its lifecycle event fires', async () => {
    const registry = await scaffoldAndRegister('stays-quiet');
    try {
      hooks.emit('message:create', {
        id: 'message-1',
        threadId: 'thread-1',
        role: 'user',
      } as never);
      // Give a listener that should not exist every chance to fire.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(logCalls).toHaveLength(0);
    } finally {
      registry.stop();
    }
  });

  it('still allows a deliberate on-demand test run while disabled', async () => {
    const registry = await scaffoldAndRegister('testable-while-disabled');
    try {
      const result = await registry.runForTest({
        hookName: 'testable-while-disabled',
        eventName: 'message:create',
        event: { id: 'message-2', threadId: 'thread-1', role: 'user' },
        context: {},
      });
      expect(result).toBeDefined();
      expect(logCalls.length).toBeGreaterThan(0);
      expect(await rowFor(registry, 'testable-while-disabled')).toMatchObject({ enabled: false });
    } finally {
      registry.stop();
    }
  });

  it('runs automatically only after a human enables it', async () => {
    const registry = await scaffoldAndRegister('enabled-by-a-person');
    try {
      await registry.setEnabled('enabled-by-a-person', true);
      expect(await rowFor(registry, 'enabled-by-a-person')).toMatchObject({ enabled: true });

      hooks.emit('message:create', {
        id: 'message-3',
        threadId: 'thread-1',
        role: 'user',
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(logCalls.length).toBeGreaterThan(0);
    } finally {
      registry.stop();
    }
  });
});
