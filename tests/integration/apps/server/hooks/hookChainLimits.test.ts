/**
 * Hook chain behavior against real PostgreSQL and real hook builds. Snaglet does not
 * refuse loops: depth and chain are recorded on every run for visibility. Two
 * guards remain, neither a loop detector: the runs-per-minute burst cap, and a
 * hook running itself synchronously via snaglet.hooks.run while still running. A
 * refused run is a failed `hook_runs` row (exit null, duration 0) whose stderr
 * names the guard and the chain. The numbered cases cover a self-looping hook,
 * A → B → A, ordinary depth-1/2 chains, the burst cap, A → A, nested
 * snaglet.hooks.run (no deadlock on shared slots; refused at once with no slot
 * left), and a loop through an agent turn. In each loop the hook's own
 * condition ends it.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { mkdir, writeFile } from 'fs/promises';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import express from 'express';
import { getDb, Messages, quoteIdentifier } from '@snaglet/db';
import type { Actor } from '@snaglet/shared/types/workspace-events';

jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableCreated: () => undefined,
  emitTableUpdated: () => undefined,
  emitTableFieldsChanged: () => undefined,
  emitTableEntriesChanged: () => undefined,
  emitTableRemoved: () => undefined,
  emitTableRestored: () => undefined,
  emitTableHistoryChanged: () => undefined,
}));

// The /run route resolves hooks through the module registry; point it at the
// registry this file builds (its children call back into this file's server).
const mockRegistry: { current?: unknown } = {};
jest.mock('@server/services/customHooks/HookRegistryService', () => {
  const actual = jest.requireActual<
    typeof import('@server/services/customHooks/HookRegistryService')
  >('@server/services/customHooks/HookRegistryService');
  return { ...actual, getHookRegistry: () => mockRegistry.current };
});

import { runWithActor } from '@server/realtime/actorContext';
import { createTable } from '@server/domains/tables/tableCatalog';
import { createTableField } from '@server/domains/tables/tableFields';
import {
  createTableEntry,
  getTableEntry,
  listTableEntries,
  updateTableEntry,
} from '@server/domains/tables/tableEntries';
import { hooks } from '@server/services/HookService';
import {
  CUSTOM_HOOKS_DIR,
  HookRegistryService,
} from '@server/services/customHooks/HookRegistryService';
import executionRoutes from '@server/domains/tools/routes/execution.routes';
import hooksRoutes from '@server/routes/hooks';
import { toolDispatchAuthMiddleware } from '@server/middleware/panelAuth';
import { errorHandler } from '@server/middleware/errorHandler';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import { settingsService } from '@server/services/settings/settingsService';
import { workerSettings } from '@server/services/settings/categories/workers';
import { Agents } from '@snaglet/db/tables/agents';
import { currentChainDepth } from '@server/realtime/runContext';
import { redispatchPersistedMessage } from '@server/services/SocketService/dispatch/dispatchToThread';
import {
  createScenario,
  pinConversationCompaction,
  pinEmbeddingsUnavailable,
  type Scenario,
} from '../services/SocketService/waveScenarios/scenarioHarness';

const USER: Actor = { actorKind: 'user', actorId: 'test-user-chain', actorName: 'Test User' };
const TABLE = 'table-1111111111111-chainlm';
const TABLE_NAME = 'hook_chain_rows';
const NOTE = 'field-1111111111111-chnote';
const NAME = `field-title-${TABLE}`;
const ROW = '44444444-4444-4444-8444-444444444444';

interface RunRow {
  hook_name: string;
  status: string;
  exit_code: number | null;
  duration_ms: number | null;
  stderr: string | null;
  chain_depth: number;
  source: string;
}

const as = <T>(fn: () => Promise<T>): Promise<T> => runWithActor(USER, fn);

async function runs(...names: string[]): Promise<RunRow[]> {
  const { rows } = await getDb().query<RunRow>(
    `SELECT hook_name, status, exit_code, duration_ms, stderr, chain_depth, source
       FROM public.hook_runs
      WHERE hook_name = ANY($1::text[])
      ORDER BY started_at, chain_depth`,
    [names]
  );
  return rows;
}

const refusalsOf = (rows: RunRow[]) =>
  rows.filter((row) => row.status === 'failed' && row.exit_code === null && row.duration_ms === 0);

async function cleanTable(): Promise<void> {
  const { rows } = await getDb().query<{ table_name: string }>(
    'SELECT table_name FROM public.table_catalog WHERE id = $1',
    [TABLE]
  );
  for (const row of rows)
    await getDb().query(
      `DROP TABLE IF EXISTS user_tables.${quoteIdentifier(row.table_name)} CASCADE`
    );
  await getDb().query('DELETE FROM public.table_fields WHERE table_id = $1', [TABLE]);
  await getDb().query('DELETE FROM public.table_catalog WHERE id = $1', [TABLE]);
  await getDb().query('DELETE FROM public.table_history WHERE actor_id = $1', [USER.actorId]);
}

async function setupTable(): Promise<void> {
  await as(() => createTable({ id: TABLE, name: TABLE_NAME }));
  await as(() =>
    createTableField(TABLE, {
      id: NOTE,
      name: 'note',
      description: null,
      type: 'text',
      nullable: true,
      defaultValue: null,
      referenceTableId: null,
    })
  );
  const { schemaVersion } = await listTableEntries(TABLE);
  await as(() =>
    createTableEntry(TABLE, { id: ROW, values: { [NAME]: 'Row', [NOTE]: 'start' }, schemaVersion })
  );
}

/** A person edits the row's note. */
async function personEdits(note: string): Promise<void> {
  const current = await getTableEntry(TABLE, ROW);
  await as(() =>
    updateTableEntry(TABLE, ROW, {
      values: { [NOTE]: note },
      expectedRevision: current.entry.revision,
      schemaVersion: current.schemaVersion,
    })
  );
}

/**
 * A self-looping hook: on every row update it reads the note, and while it is
 * below `max` writes `loop <n+1>`, firing itself again. It stops on its own at
 * `loop <max>` (its own condition, not a refusal), so a chain of `max` hops
 * runs and then quiesces: Snaglet does not refuse deep or repeating chains.
 */
const boundedSelfLoop = (max: number) => `import { defineHook, snaglet } from '@snaglet/sdk';
export default defineHook({
  on: 'table_entry:update',
  filter: { tableId: ${JSON.stringify(TABLE)} },
  async run(event) {
    const change = (event.changes || []).find((c) => c.field === ${JSON.stringify(NOTE)});
    const note = String(change ? change.to : '');
    const m = /^loop (\\d+)$/.exec(note);
    const n = m ? Number(m[1]) : 0;
    if (n >= ${max}) return; // the loop ends on its own
    const result = await snaglet.tools.execute('table', {
      op: 'write',
      table: ${JSON.stringify(TABLE_NAME)},
      update: [{ id: event.entryId, values: { note: 'loop ' + (n + 1) } }],
    });
    if (!result.success) throw new Error(result.error || 'table write failed');
  },
});
`;

/** A hook on one signal that emits another (or nothing). */
const relay = (
  on: string,
  emit: string | null,
  extra = ''
) => `import { defineHook, snaglet } from '@snaglet/sdk';
export default defineHook({
  on: 'hook:signal',
  filter: { name: ${JSON.stringify(on)} },
  ${extra}
  async run() {
    ${emit ? `await snaglet.emit(${JSON.stringify(emit)});` : ''}
  },
});
`;

/** A hook that runs `next` with snaglet.hooks.run and fails if that run did. */
const nester = (next: string | null) => `import { defineHook, snaglet } from '@snaglet/sdk';
export default defineHook({
  on: 'hook:signal',
  filter: { name: 'test.never' },
  async run() {
    ${
      next
        ? `const [run] = await snaglet.hooks.run(${JSON.stringify(next)});
    if (!run || !run.result.ok) throw new Error('nested run failed: ' + (run ? run.result.stderr : 'none'));`
        : ''
    }
  },
});
`;

/** A hook that tries to run itself with snaglet.hooks.run while running. */
const selfNester = (name: string) => `import { defineHook, snaglet } from '@snaglet/sdk';
export default defineHook({
  on: 'hook:signal',
  filter: { name: 'test.never' },
  async run() {
    const [run] = await snaglet.hooks.run(${JSON.stringify(name)});
    if (!run || run.result.ok) throw new Error('expected the nested self-run to be refused');
    if (!run.result.stderr.includes("can't run itself")) {
      throw new Error('wrong refusal: ' + run.result.stderr);
    }
  },
});
`;

function signal(name: string): void {
  hooks.emit('hook:signal', { name, data: null, hookName: null, agentId: null, chainDepth: 0 });
}

describe('hook chain limits (real DB, real hook builds)', () => {
  let server: http.Server;
  let serverUrl: string;
  let registry: HookRegistryService;
  const emitOriginal = hooks.emit.bind(hooks);

  function newRegistry(concurrency = 4): HookRegistryService {
    const created = new HookRegistryService({
      dir: CUSTOM_HOOKS_DIR,
      serverUrl,
      hookTimeoutMs: 20_000,
      describeTimeoutMs: 20_000,
      concurrency,
    });
    mockRegistry.current = created;
    return created;
  }

  async function writeHook(name: string, source: string, enable = true): Promise<void> {
    const dir = path.join(CUSTOM_HOOKS_DIR, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'hook.ts'), source, 'utf-8');
    await registry.registerHookFolder(name);
    if (enable) await registry.setEnabled(name, true);
  }

  async function until(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('timed out waiting');
  }

  /** Until no hook run is in flight for a while (dispatch defers a settings read first). */
  async function quiet(): Promise<void> {
    let idleSince = Date.now();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await registry.getRunner().settle();
      if (registry.getRunner().inFlightCount > 0) idleSince = Date.now();
      if (Date.now() - idleSince >= 1_500) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  beforeAll(async () => {
    await toolRegistry.load();
    const sync = await toolRegistry.syncToDatabase();
    expect(sync.errors).toEqual([]);
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => runWithActor(USER, () => next()));
    app.use('/api/tools', toolDispatchAuthMiddleware, executionRoutes);
    app.use('/api/hooks', hooksRoutes);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  beforeEach(async () => {
    await cleanTable();
    await setupTable();
    registry = newRegistry();
    // The self-origin guard mocked off: no event carries an origin, so every
    // stop below is the chain guard's.
    jest.spyOn(hooks, 'emit').mockImplementation((event, payload) => {
      const { origin: _origin, ...rest } = payload as Record<string, unknown>;
      emitOriginal(event, rest as never);
    });
  });

  afterEach(async () => {
    await quiet();
    registry.stop();
    jest.restoreAllMocks();
    await settingsService.revert(workerSettings.hooksMaxRunsPerMinute);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanTable();
  });

  it('1. a self-looping hook runs a 40-hop chain, depth climbing, then stops on its own', async () => {
    const hops = 40;
    await writeHook('test-chain-self', boundedSelfLoop(hops));
    await personEdits('loop 0');
    // The chain runs hop after hop and ends itself at `loop <hops>`.
    await until(async () => (await runs('test-chain-self')).length >= hops, 180_000);
    await quiet();

    const rows = await runs('test-chain-self');
    // Every hop ran — no refusal anywhere — and depth kept counting past 32.
    expect(refusalsOf(rows)).toHaveLength(0);
    expect(rows.length).toBeGreaterThanOrEqual(hops);
    expect(rows.every((row) => row.status === 'succeeded')).toBe(true);
    const depths = rows.map((row) => row.chain_depth);
    expect(Math.max(...depths)).toBeGreaterThan(32);
    expect((await getTableEntry(TABLE, ROW)).entry.values[NOTE]).toBe(`loop ${hops}`);
  }, 240_000);

  it('2. A → B → A → B … — a hook already in the chain is not refused on its repeat', async () => {
    // Two hooks take turns writing the row's note: A advances it on even
    // counts, B on odd, so the chain is A → B → A → B … Each stops once the
    // note reaches the cap. The point is that A's and B's second runs (already
    // in the chain) are not refused — the counter in the persisted note, not a
    // module-level variable, bounds the loop across fresh child processes.
    const cap = 5;
    const turn = (name: string, mine: 0 | 1) => `import { defineHook, snaglet } from '@snaglet/sdk';
export default defineHook({
  on: 'table_entry:update',
  filter: { tableId: ${JSON.stringify(TABLE)} },
  async run(event) {
    const change = (event.changes || []).find((c) => c.field === ${JSON.stringify(NOTE)});
    const note = String(change ? change.to : '');
    const m = /^loop (\\d+)$/.exec(note);
    if (!m) return;
    const n = Number(m[1]);
    if (n >= ${cap}) return;        // the loop ends on its own
    if (n % 2 !== ${mine}) return;  // not this hook's turn
    const result = await snaglet.tools.execute('table', {
      op: 'write',
      table: ${JSON.stringify(TABLE_NAME)},
      update: [{ id: event.entryId, values: { note: 'loop ' + (n + 1) } }],
    });
    if (!result.success) throw new Error(result.error || 'table write failed');
  },
});
`;
    await writeHook('test-chain-a', turn('test-chain-a', 0));
    await writeHook('test-chain-b', turn('test-chain-b', 1));
    await personEdits('loop 0');
    await until(async () => (await runs('test-chain-a', 'test-chain-b')).length >= cap, 120_000);
    await quiet();

    const rows = await runs('test-chain-a', 'test-chain-b');
    // Every hop ran; A and B each appear more than once with no refusal.
    expect(refusalsOf(rows)).toHaveLength(0);
    expect(rows.every((row) => row.status === 'succeeded')).toBe(true);
    expect(rows.filter((r) => r.hook_name === 'test-chain-a').length).toBeGreaterThan(1);
    expect(rows.filter((r) => r.hook_name === 'test-chain-b').length).toBeGreaterThan(1);
    expect(Math.max(...rows.map((r) => r.chain_depth))).toBeGreaterThanOrEqual(cap);
    expect((await getTableEntry(TABLE, ROW)).entry.values[NOTE]).toBe(`loop ${cap}`);
  }, 180_000);

  it('3. ordinary depth-1 and depth-2 chains still run, through a signal and hook:finished', async () => {
    await writeHook('test-chain-first', relay('test.first', 'test.second'));
    await writeHook('test-chain-second', relay('test.second', null));
    await writeHook(
      'test-chain-after',
      `import { defineHook } from '@snaglet/sdk';
export default defineHook({
  on: 'hook:finished',
  filter: { hookName: 'test-chain-first' },
  async run() {},
});
`
    );
    signal('test.first');
    await until(async () => (await runs('test-chain-second', 'test-chain-after')).length >= 2);
    await quiet();

    const rows = await runs('test-chain-first', 'test-chain-second', 'test-chain-after');
    expect(rows.map((row) => [row.hook_name, row.status, row.chain_depth]).sort()).toEqual([
      ['test-chain-after', 'succeeded', 2],
      ['test-chain-first', 'succeeded', 1],
      ['test-chain-second', 'succeeded', 2],
    ]);
  }, 90_000);

  it('4. a runs-per-minute limit of 5 still stops at 5 (the burst cap)', async () => {
    await settingsService.write(workerSettings.hooksMaxRunsPerMinute, 5);
    await writeHook('test-chain-burst', relay('test.burst', null));
    for (let i = 0; i < 8; i += 1) signal('test.burst');
    await until(async () => (await runs('test-chain-burst')).length >= 6);
    await quiet();

    const rows = await runs('test-chain-burst');
    // Five runs and one refusal row; the other two refusals are counted, not rowed.
    expect(rows.filter((row) => row.status === 'succeeded')).toHaveLength(5);
    const refusals = refusalsOf(rows);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.stderr).toBe(
      'Stopped by the runs-per-minute limit: "test-chain-burst" already ran 5 times in the ' +
        'last minute (limit: workers.hooks_max_runs_per_minute = 5). Chain: test-chain-burst.'
    );
    expect(rows).toHaveLength(6);
  }, 90_000);

  it('5. a hook that re-triggers itself (A → A → A) runs every repeat — not refused — and ends on its own condition', async () => {
    // A single hook whose own write re-fires it. It is in its own chain on
    // every repeat, yet none is refused; the persisted note bounds it to three
    // runs (depth 1, 2, 3), proving the A → A repeat is allowed.
    const cap = 3;
    await writeHook('test-chain-echo', boundedSelfLoop(cap));
    await personEdits('loop 0');
    // cap writes, then one last no-op run that sees `loop <cap>` and stops:
    // cap + 1 runs, each a hop deeper, none refused.
    await until(async () => (await runs('test-chain-echo')).length >= cap + 1, 90_000);
    await quiet();

    const rows = await runs('test-chain-echo');
    expect(refusalsOf(rows)).toHaveLength(0);
    expect(rows.map((row) => [row.status, row.chain_depth])).toEqual([
      ['succeeded', 1],
      ['succeeded', 2],
      ['succeeded', 3],
      ['succeeded', 4],
    ]);
    expect((await getTableEntry(TABLE, ROW)).entry.values[NOTE]).toBe(`loop ${cap}`);
  }, 120_000);

  describe('6. nested snaglet.hooks.run of different hooks', () => {
    const NAMES = ['test-nest-1', 'test-nest-2', 'test-nest-3', 'test-nest-4', 'test-nest-5'];

    async function writeNest(): Promise<void> {
      await getDb().query('DELETE FROM public.hook_runs WHERE hook_name = ANY($1::text[])', [
        NAMES,
      ]);
      for (let i = 0; i < NAMES.length; i += 1) {
        await writeHook(NAMES[i]!, nester(NAMES[i + 1] ?? null));
      }
    }

    it('A → B → C → D → E holds more than the 4 shared slots and still finishes, without waiting on a timeout', async () => {
      await writeNest();
      const startedAt = Date.now();
      const result = await registry.runForTest({
        hookName: NAMES[0]!,
        eventName: 'schedule:fire',
        event: {},
      });
      expect(result.stderr).toBe('');
      expect(result.ok).toBe(true);
      // A deadlock would hold until the 20 s hook timeout killed the waiters.
      expect(Date.now() - startedAt).toBeLessThan(15_000);
      const rows = await runs(...NAMES);
      expect(rows.map((row) => [row.hook_name, row.status, row.chain_depth])).toEqual(
        NAMES.map((name, i) => [name, 'succeeded', i + 1])
      );
    }, 120_000);

    it('with no slot left, the nested run is refused at once with the reason, and the chain unwinds', async () => {
      registry.stop();
      registry = newRegistry(1);
      await writeNest();
      const startedAt = Date.now();
      const result = await registry.runForTest({
        hookName: NAMES[0]!,
        eventName: 'schedule:fire',
        event: {},
      });
      expect(result.ok).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(15_000);

      const rows = await runs(...NAMES);
      // 1 holds the shared slot, 2 the nested slot; 3 finds neither.
      expect(rows.map((row) => [row.hook_name, row.status, row.chain_depth])).toEqual([
        ['test-nest-1', 'failed', 1],
        ['test-nest-2', 'failed', 2],
        ['test-nest-3', 'failed', 3],
      ]);
      const [refusal] = refusalsOf(rows);
      expect(refusal).toMatchObject({ hook_name: 'test-nest-3', source: 'manual' });
      expect(refusal!.stderr).toBe(
        'Stopped by the nested-run slot limit: all 1 nested-run slots and all 1 hook slots are ' +
          'in use, and a nested run never waits for one (it would deadlock the hooks waiting on ' +
          'it). Chain: test-nest-1 → test-nest-2 → test-nest-3.'
      );
      // The callers saw the reason.
      expect(rows[1]!.stderr).toContain('nested-run slot limit');
      expect(result.stderr).toContain('nested run failed');
    }, 120_000);

    it('a hook running itself via snaglet.hooks.run while running is still refused', async () => {
      await getDb().query('DELETE FROM public.hook_runs WHERE hook_name = $1', ['test-nest-self']);
      await writeHook('test-nest-self', selfNester('test-nest-self'));
      const result = await registry.runForTest({
        hookName: 'test-nest-self',
        eventName: 'schedule:fire',
        event: {},
      });
      // The outer run succeeds because the hook body asserts the nested self-run
      // came back refused with the right reason.
      expect(result.ok).toBe(true);
      await quiet();

      const rows = await runs('test-nest-self');
      const refusals = refusalsOf(rows);
      expect(refusals).toHaveLength(1);
      expect(refusals[0]!.stderr).toContain("can't run itself");
      expect(refusals[0]!.stderr).toContain('Chain: test-nest-self → test-nest-self.');
    }, 120_000);
  });
  describe('7. through an agent turn the hook starts', () => {
    pinConversationCompaction();
    pinEmbeddingsUnavailable();
    let scenarios: Scenario[] = [];

    /** A thread with one scripted agent that writes the row once, then replies. */
    async function agentThread(prefix: string, note: string): Promise<Scenario> {
      const scenario = await createScenario({
        prefix,
        agents: [
          {
            key: 'writer',
            script: [
              {
                toolCalls: [
                  {
                    name: 'table',
                    input: {
                      op: 'write',
                      table: TABLE_NAME,
                      update: [{ id: ROW, values: { note } }],
                    },
                  },
                ],
              },
              { reply: 'done' },
            ],
          },
        ],
      });
      await Agents.update(scenario.ids.writer!, { toolAccessAllowList: ['table'] });
      scenarios.push(scenario);
      return scenario;
    }

    /**
     * A hook on the row's updates that asks an agent to update the row: at
     * depth 1 the agent in `first`, deeper the agent in `second` (a separate,
     * idle thread, so each wake runs in the context of the run that sent it).
     */
    const asksAnAgent = (
      first: string,
      second: string,
      extra = ''
    ) => `import { defineHook, snaglet } from '@snaglet/sdk';
export default defineHook({
  on: 'table_entry:update',
  filter: { tableId: ${JSON.stringify(TABLE)} },
  ${extra}
  async run() {
    const threadId = process.env.SNAGLET_CHAIN_DEPTH === '1' ? ${JSON.stringify(first)} : ${JSON.stringify(second)};
    const result = await snaglet.tools.execute('thread', {
      op: 'send',
      thread_id: threadId,
      content: 'Please update the row.',
    });
    if (!result.success) throw new Error(result.error || 'send failed');
  },
});
`;

    const replied = async (scenario: Scenario): Promise<boolean> =>
      (await scenario.assistantMessages()).some(
        (message) => message.agentId === scenario.ids.writer && message.content === 'done'
      );

    afterEach(async () => {
      for (const scenario of scenarios) await scenario.cleanup();
      scenarios = [];
    });

    it('the agent’s write fires the hook again and it runs (no refusal); its depth climbs', async () => {
      // A messages an agent, whose write fires A again at depth 2. The agent's
      // script has one write + reply, so the round trip ends on its own — but
      // the second A run is not refused for repeating in the chain.
      const first = await agentThread('chainagent1', 'agent 1');
      await writeHook('test-chain-via-agent', asksAnAgent(first.threadId, first.threadId));
      await personEdits('by a person');
      await until(async () => (await runs('test-chain-via-agent')).length >= 2, 60_000);
      await until(() => replied(first), 30_000);
      await quiet();

      const rows = await runs('test-chain-via-agent');
      expect(refusalsOf(rows)).toHaveLength(0);
      // depth 1 (person's edit → A), then depth 2 (agent's write → A again).
      expect(rows.map((row) => [row.status, row.chain_depth])).toEqual([
        ['succeeded', 1],
        ['succeeded', 2],
      ]);
      // The agent did write: its turn ran, and the hook ran again afterward.
      expect((await getTableEntry(TABLE, ROW)).entry.values[NOTE]).toBe('agent 1');
    }, 120_000);

    it('a persisted hook message redispatched after a restart still records its depth and does not refuse', async () => {
      // The process restarted: nothing in memory, only the hook's message row,
      // stamped at depth 3 when the hook sent it to the busy thread.
      // RunReaperService and the chatHandlers retry both deliver it through
      // redispatchPersistedMessage, from a fresh (depth 0) context. The
      // agent's write then fires the hook at depth 4, which runs (no
      // depth refusal), recording depth 4. The agent's one-shot script ends
      // the round trip.
      const scenario = await agentThread('chainrestart', 'after restart');
      const hookName = 'test-chain-restart';
      await writeHook(hookName, asksAnAgent(scenario.threadId, scenario.threadId));
      const messageId = `message-chainrestart-${Date.now()}`;
      await Messages.create({
        id: messageId,
        threadId: scenario.threadId,
        role: 'assistant',
        content: 'Please update the row.',
        // A hook's thread op:send is sent as the ghost agent.
        agentId: 'ghost',
        messageType: 'message',
        metadata: { chain: { depth: 3, hooks: [hookName, hookName, hookName] } },
      });
      expect(currentChainDepth()).toBe(0);

      await redispatchPersistedMessage({
        threadId: scenario.threadId,
        threadName: 'chainrestart',
        messageId,
        coveredMessageIds: [messageId],
        undeliveredCount: 1,
        reason: 'run reaped with undelivered mid-run messages',
      });
      await until(async () => (await runs(hookName)).length >= 1, 60_000);
      await until(() => replied(scenario), 30_000);
      await quiet();

      // The agent's write fired the hook at depth 4 and it ran (depth recorded,
      // no refusal). The stamp carried the depth across the "restart".
      const rows = await runs(hookName);
      expect(refusalsOf(rows)).toHaveLength(0);
      expect(rows.map((row) => [row.status, row.chain_depth])).toEqual([['succeeded', 4]]);
      expect((await getTableEntry(TABLE, ROW)).entry.values[NOTE]).toBe('after restart');
    }, 120_000);
  });
});
