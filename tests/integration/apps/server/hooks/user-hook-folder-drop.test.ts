/**
 * Folder-drop user lifecycle hooks, end to end. Hook folders are created in an
 * OS temp dir (outside the monorepo, so the vendored-SDK build seam is
 * exercised), HookRegistryService runs as at boot (build → describe →
 * subscribe), and real events on the internal `hooks` bus fire them. A small
 * local HTTP server stands in for Snaglet so `snaglet.tools.execute(...)` round-trips
 * under the invoking agent's id. Also covers robustness: a pre-filter miss
 * never spawns, a hook that throws is logged without touching the message flow,
 * a hook that hangs is killed at its timeout, and run:end and
 * table_entry:update are observable.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import { getDb } from '@snaglet/db';
import { hooks } from '@server/services/HookService';
import { HookRegistryService } from '@server/services/customHooks/HookRegistryService';

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

/** A hook that forwards each event to `memory_store` so the mock server sees it. */
function memoryStoreHook(on: string, filter?: Record<string, unknown>): string {
  return `
import { defineHook, snaglet } from '@snaglet/sdk';
export default defineHook({
  on: ${JSON.stringify(on)},
  ${filter ? `filter: ${JSON.stringify(filter)},` : ''}
  async run(event) {
    const ctx = snaglet.context.get();
    await snaglet.tools.execute('memory_store', { event_type: event.type, id: event.id, sawAgent: ctx.agentId ?? null });
  },
});
`;
}

describe('user lifecycle hooks folder-drop (E2E)', () => {
  let hooksRoot: string;
  let server: http.Server;
  let serverUrl: string;
  let received: CapturedRequest[] = [];

  beforeAll(async () => {
    hooksRoot = await mkdtemp(path.join(tmpdir(), 'snaglet-hooks-'));
    getDb(); // open the per-file embedded DB (parity with the custom-tool folder-drop smoke test)

    // Mock Snaglet server: records every request and returns the success envelope the
    // vendored SDK expects for /api/tools/execute (and 200 for the log endpoint).
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          body = {};
        }
        received.push({ url: req.url ?? '', body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            data:
              req.url === '/api/hooks/content/resolve'
                ? { id: 'doc-live', kind: 'doc', content: 'current document value' }
                : { success: true, output: 'ok', durationMs: 1 },
          })
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(hooksRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    received = [];
  });

  async function writeHook(name: string, source: string): Promise<void> {
    const dir = path.join(hooksRoot, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'hook.ts'), source, 'utf-8');
  }

  function newRegistry(opts?: { hookTimeoutMs?: number }): HookRegistryService {
    return new HookRegistryService({
      dir: hooksRoot,
      serverUrl,
      hookTimeoutMs: opts?.hookTimeoutMs ?? 8_000,
      describeTimeoutMs: 8_000,
      concurrency: 4,
    });
  }

  async function registerEnabled(registry: HookRegistryService, name: string): Promise<void> {
    await registry.registerHookFolder(name);
    await registry.setEnabled(name, true);
  }

  const executeCalls = (): CapturedRequest[] =>
    received.filter((r) => r.url === '/api/tools/execute');

  /**
   * Barrier for a bus-emitted hook run. `HookRunner.settle()` alone is not
   * enough: `HookRegistryService.dispatch` awaits a
   * `settingsService.read(workers.hooks_enabled)` before `runner.run()`
   * registers the work, so right after `hooks.emit()` there is nothing to
   * settle. Drain until the expected tool calls arrive or, for negative cases,
   * until the runner has been idle long enough to cover that read.
   */
  async function settleHooks(registry: HookRegistryService, expected = 0): Promise<void> {
    const startedAt = Date.now();
    const deadline = startedAt + 20_000;
    let idleDrains = 0;
    while (Date.now() < deadline) {
      await registry.getRunner().settle();
      if (expected > 0 && executeCalls().length >= expected) return;
      idleDrains = registry.getRunner().inFlightCount === 0 ? idleDrains + 1 : 0;
      if (expected === 0 && idleDrains >= 3 && Date.now() - startedAt >= 400) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it('registers a new hook disabled but still permits an explicit test run', async () => {
    await writeHook('draft-hook', memoryStoreHook('message:create'));
    const registry = newRegistry();
    try {
      await registry.registerHookFolder('draft-hook');
      const row = (await registry.listRegistrations()).find((item) => item.name === 'draft-hook');
      expect(row).toMatchObject({ enabled: false, buildStatus: 'ready' });
      expect(row?.builtPath).toContain(`${path.sep}.snaglet-build${path.sep}`);
      await expect(stat(path.join(hooksRoot, 'draft-hook', 'node_modules'))).rejects.toThrow();

      hooks.emit('message:create', {
        id: 'automatic-message',
        threadId: 'thread-1',
        role: 'user',
      });
      await settleHooks(registry);
      expect(executeCalls()).toHaveLength(0);

      const result = await registry.runForTest({
        hookName: 'draft-hook',
        eventName: 'message:create',
        event: { type: 'message:create', id: 'manual-message', threadId: 'thread-1', role: 'user' },
      });
      expect(result.ok).toBe(true);
      expect(executeCalls()).toHaveLength(1);
    } finally {
      registry.stop();
    }
  }, 60_000);

  it('a message:create hook fires with no API call and runs a tool under the agent id', async () => {
    await writeHook(
      'self-improve-after-message',
      memoryStoreHook('message:create', { role: 'agent' })
    );
    const registry = newRegistry();
    try {
      await registerEnabled(registry, 'self-improve-after-message');
      expect(registry.registeredHookNames).toContain('self-improve-after-message');

      // No REST call — just the next agent message on the internal bus.
      hooks.emit('message:create', {
        id: 'msg-1',
        threadId: 'thread-1',
        role: 'agent',
        agentId: 'agent-alpha',
      });
      await settleHooks(registry, 1);

      const calls = executeCalls();
      expect(calls).toHaveLength(1);
      // The SDK forwarded the invoking agent's id → the tool runs under that agent's policy.
      expect(calls[0]!.body.name).toBe('memory_store');
      expect(calls[0]!.body.agent_id).toBe('agent-alpha');
      const input = calls[0]!.body.input as Record<string, unknown>;
      expect(input.event_type).toBe('message:create');
      expect(input.sawAgent).toBe('agent-alpha');
      expect(input.id).toBe('msg-1');
    } finally {
      registry.stop();
    }
  }, 60_000);

  it('pre-filter skips a non-matching event before spawning any child', async () => {
    await writeHook('agent-only', memoryStoreHook('message:create', { role: 'agent' }));
    const registry = newRegistry();
    try {
      await registerEnabled(registry, 'agent-only');
      // role:'user' does not match filter {role:'agent'} → no spawn, no call.
      hooks.emit('message:create', {
        id: 'msg-user',
        threadId: 'thread-1',
        role: 'user',
      });
      await settleHooks(registry);
      expect(registry.getRunner().inFlightCount).toBe(0);
      expect(executeCalls()).toHaveLength(0);
    } finally {
      registry.stop();
    }
  }, 60_000);

  it('snaglet.parseContent resolves the current node value at hook runtime', async () => {
    await writeHook(
      'dynamic-parameter',
      `
import { defineHook, snaglet } from '@snaglet/sdk';
export default defineHook({
  on: 'message:create',
  async run() {
    const param = await snaglet.parseContent('doc-live');
    await snaglet.tools.execute('memory_store', { param });
  },
});
`
    );
    const registry = newRegistry();
    try {
      await registerEnabled(registry, 'dynamic-parameter');
      hooks.emit('message:create', { id: 'msg-live', threadId: 'thread-1', role: 'user' });
      await settleHooks(registry, 1);
      expect(received.some((request) => request.url === '/api/hooks/content/resolve')).toBe(true);
      const call = executeCalls()[0];
      expect((call?.body.input as Record<string, unknown>)?.param).toBe('current document value');
    } finally {
      registry.stop();
    }
  }, 60_000);

  it('reconciles defineHook schedule declarations and runs a schedule-only hook', async () => {
    await writeHook(
      'scheduled-report',
      `
import { defineHook, snaglet } from '@snaglet/sdk';
export default defineHook({
  schedule: [
    { every: 15, unit: 'minute' },
    { time: '09:00', timezone: 'America/Los_Angeles', weekdays: [1, 2, 3, 4, 5] },
    { at: '2030-01-01T00:00:00.000Z' },
  ],
  async run(event) {
    await snaglet.tools.execute('memory_store', { event_type: event.type });
  },
});
`
    );
    const registry = newRegistry();
    try {
      await registerEnabled(registry, 'scheduled-report');
      expect(registry.registeredHookNames).toContain('scheduled-report');
      const { rows } = await getDb().query<{ id: string; schedule_kind: string }>(
        `SELECT id, schedule_kind FROM schedules
          WHERE action_json->>'source'='hook-definition'
            AND action_json->>'hookName'='scheduled-report'
          ORDER BY schedule_kind`
      );
      expect(rows.map((row) => row.schedule_kind)).toEqual(['calendar', 'interval', 'once']);

      const result = await registry.runForTest({
        hookName: 'scheduled-report',
        eventName: 'schedule:fire',
        event: {
          scheduleId: rows[0]!.id,
          runId: 'manual-test-run',
          scheduledFor: new Date().toISOString(),
        },
      });
      expect(result.ok).toBe(true);
      expect(
        executeCalls().some(
          (call) => (call.body.input as Record<string, unknown>).event_type === 'schedule:fire'
        )
      ).toBe(true);
    } finally {
      registry.stop();
      await getDb().query(
        `DELETE FROM schedules WHERE action_json->>'hookName'='scheduled-report'`
      );
    }
  }, 60_000);

  it('run:end and table_entry:update are observable by a test hook', async () => {
    await writeHook('on-run-end', memoryStoreHook('run:end'));
    await writeHook('on-task-status', memoryStoreHook('table_entry:update'));
    const registry = newRegistry();
    try {
      await registerEnabled(registry, 'on-run-end');
      await registerEnabled(registry, 'on-task-status');

      hooks.emit('run:end', {
        runId: 'run-9',
        agentId: 'agent-beta',
        threadId: 'thread-2',
        status: 'completed',
      });
      hooks.emit('table_entry:update', {
        tableId: 'table-1111111111111-aaaaaaaaa',
        entryId: '00000000-0000-4000-8000-000000000007',
        changes: [{ field: 'field-1111111111111-status', from: 'active', to: 'done' }],
      });
      await settleHooks(registry, 2);

      const types = executeCalls().map((c) => (c.body.input as Record<string, unknown>).event_type);
      expect(types).toContain('run:end');
      expect(types).toContain('table_entry:update');
    } finally {
      registry.stop();
    }
  }, 60_000);

  it('agent:create, agent:update, and agent:delete compile through the vendored SDK and fire', async () => {
    await writeHook('on-agent-create', memoryStoreHook('agent:create'));
    await writeHook('on-agent-update', memoryStoreHook('agent:update'));
    await writeHook('on-agent-delete', memoryStoreHook('agent:delete'));
    const registry = newRegistry();
    try {
      await registerEnabled(registry, 'on-agent-create');
      await registerEnabled(registry, 'on-agent-update');
      await registerEnabled(registry, 'on-agent-delete');

      hooks.emit('agent:create', { id: 'agent-new' });
      hooks.emit('agent:update', { id: 'agent-new', changed: ['name'] });
      hooks.emit('agent:delete', { id: 'agent-old' });
      await settleHooks(registry, 3);

      const types = executeCalls().map(
        (call) => (call.body.input as Record<string, unknown>).event_type
      );
      expect(types).toEqual(
        expect.arrayContaining(['agent:create', 'agent:update', 'agent:delete'])
      );
    } finally {
      registry.stop();
    }
  }, 60_000);

  it('a hook that throws is isolated — emit stays synchronous, no crash, no tool call', async () => {
    await writeHook(
      'boom',
      `
import { defineHook } from '@snaglet/sdk';
export default defineHook({
  on: 'message:create',
  run() { throw new Error('intentional hook failure'); },
});
`
    );
    const registry = newRegistry();
    try {
      await registerEnabled(registry, 'boom');
      // The emit itself must not throw (crash isolation at the bus boundary).
      expect(() =>
        hooks.emit('message:create', {
          id: 'msg-x',
          threadId: 'thread-3',
          role: 'agent',
          agentId: 'agent-x',
        })
      ).not.toThrow();
      await settleHooks(registry);
      // Hook threw before calling any tool.
      expect(executeCalls()).toHaveLength(0);
      // Bus + registry still healthy afterward.
      expect(registry.registeredHookNames).toContain('boom');
    } finally {
      registry.stop();
    }
  }, 60_000);

  it('a hook that hangs is killed at its timeout and the message flow is unaffected', async () => {
    await writeHook(
      'hang',
      `
import { defineHook } from '@snaglet/sdk';
export default defineHook({
  on: 'message:create',
  // A live 60s timer keeps the process alive so the runner's timeout must SIGKILL it.
  async run() { await new Promise((resolve) => setTimeout(resolve, 60_000)); },
});
`
    );
    const registry = newRegistry({ hookTimeoutMs: 1_500 });
    try {
      await registerEnabled(registry, 'hang');
      const t0 = Date.now();
      // Emitting returns immediately even though the hook will hang → message flow unaffected.
      hooks.emit('message:create', {
        id: 'msg-hang',
        threadId: 'thread-4',
        role: 'agent',
        agentId: 'agent-h',
      });
      const emitElapsed = Date.now() - t0;
      expect(emitElapsed).toBeLessThan(500);

      // settle resolves once the hung child is SIGKILL'd at the timeout.
      await settleHooks(registry);
      const totalElapsed = Date.now() - t0;
      expect(totalElapsed).toBeGreaterThanOrEqual(1_400);
      expect(totalElapsed).toBeLessThan(10_000);
      expect(registry.getRunner().inFlightCount).toBe(0);
    } finally {
      registry.stop();
    }
  }, 60_000);

  it('unregisters a hook so it stops receiving events', async () => {
    await writeHook('ephemeral', memoryStoreHook('message:create'));
    const registry = newRegistry();
    try {
      await registerEnabled(registry, 'ephemeral');
      registry.unregisterHook('ephemeral');
      expect(registry.registeredHookNames).not.toContain('ephemeral');
      hooks.emit('message:create', {
        id: 'msg-after-unreg',
        threadId: 'thread-5',
        role: 'agent',
        agentId: 'agent-z',
      });
      await settleHooks(registry);
      expect(executeCalls()).toHaveLength(0);
    } finally {
      registry.stop();
    }
  }, 60_000);
});
