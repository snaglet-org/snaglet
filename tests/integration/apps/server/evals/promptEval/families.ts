/**
 * Prompt-eval task families:
 *   durable-continuity — a decision given in session 1 is answerable in
 *     session 2 from the workspace;
 *   collaboration — the lead @-tags the teammate it hands off to, who wakes;
 *   error-recovery — the user's rev is stale (a person edited the row first)
 *     and the agent still lands the write without duplicating or deleting it;
 *   long-work — a 12-item checklist in an existing task table over two
 *     sessions: read before writing, all items Done, no new table;
 *   long-work-trivial — a one-step task gets no checklist (the negative case).
 * Each family supplies fixture setup, user turns, a state oracle that reads the
 * database (never the agent's claims), a safety check, and for scripted mode a
 * `good` and `bad` script per agent: good must pass and bad must fail, or the
 * runner is broken and no live result can be trusted.
 */

import { createHash } from 'node:crypto';
import { getDb, quoteIdentifier } from '@snaglet/db';
import { Memories } from '@snaglet/db/tables/memories';
import type { ScriptedTurn } from '@server/services/ProviderChatService/providers/scripted';
import { runWithActor } from '@server/realtime/actorContext';
import { createTable } from '@server/domains/tables/tableCatalog';
import { createTableField } from '@server/domains/tables/tableFields';
import {
  createTableEntry,
  getTableEntry,
  listTableEntries,
  updateTableEntry,
} from '@server/domains/tables/tableEntries';
import type { Actor } from '@snaglet/shared/types/workspace-events';

export type Fixture = Record<string, string>;

export interface TrialView {
  ids: Record<string, string>;
  names: Record<string, string>;
  threadId: string;
  /** Assistant messages, oldest first. */
  assistantTexts(): Promise<Array<{ agentId: string | null; content: string }>>;
  /** Tool calls, oldest first; `session` is the index of the user turn they ran under. */
  toolCalls(): Promise<Array<{ tool: string | null; input: unknown; session: number }>>;
}

export interface OracleResult {
  success: boolean;
  /** False = an effect outside the task's authorized ones. */
  safe: boolean;
  notes: string[];
}

export interface AgentRole {
  key: string;
  /** Tool allow-list; identical in B and C. */
  tools: string[];
  /** The agent's own role text; identical in B and C. */
  role: string;
  /** Scripted mode only (a function so it can read fixture ids). */
  script(kind: ScriptKind, fx: Fixture, names: Record<string, string>): ScriptedTurn[];
}

/** 'good' must pass the oracle; 'bad' and each of a family's `extraBad` must fail it. */
export type ScriptKind = 'good' | 'bad' | 'bad-noread';

export interface TaskFamily {
  /** More bad scripts beyond 'bad', each probing one oracle condition. */
  extraBad?: ScriptKind[];
  id: 'durable-continuity' | 'collaboration' | 'error-recovery' | 'long-work' | 'long-work-trivial';
  dispatchMode: 'all' | 'mentioned';
  agents: AgentRole[];
  setup(prefix: string): Promise<Fixture>;
  /** One user message per session; each is a separate dispatch run. */
  turns(fx: Fixture, names: Record<string, string>): string[];
  /** Before user turn `index` is sent. */
  beforeTurn?(index: number, fx: Fixture): Promise<void>;
  oracle(trial: TrialView, fx: Fixture): Promise<OracleResult>;
  cleanup(fx: Fixture): Promise<void>;
}

const PERSON: Actor = { actorKind: 'user', actorId: 'eval-person', actorName: 'Eval Person' };
const asPerson = <T>(fn: () => Promise<T>): Promise<T> => runWithActor(PERSON, fn);

const mentionsBackoff = (text: string): boolean => /exponential/i.test(text) && /\b60\b/.test(text);

// continuity

const durableContinuity: TaskFamily = {
  id: 'durable-continuity',
  dispatchMode: 'all',
  agents: [
    {
      key: 'worker',
      tools: ['doc', 'memory', 'search'],
      role: 'You are an engineer on the platform team.',
      script(kind, fx) {
        if (kind === 'bad') {
          return [
            { reply: 'Noted, I will keep that in mind.' },
            { reply: 'I am not sure what we decided.' },
          ];
        }
        return [
          {
            toolCalls: [
              {
                name: 'doc',
                input: {
                  op: 'create',
                  title: `Decision: retry backoff ${fx.tag}`,
                  content: 'Decided: retry backoff is exponential, capped at 60 seconds.',
                },
              },
            ],
          },
          { reply: 'Recorded in the decision doc.' },
          { reply: 'We decided exponential backoff, capped at 60 seconds.' },
        ];
      },
    },
  ],
  async setup(prefix) {
    // Docs created during the trial are the agent's (agent-created docs carry
    // no created_by member id), so scope the oracle by time, not author.
    const { rows } = await getDb().query<{ now: string }>('SELECT now()::text AS now');
    return { tag: prefix, since: rows[0]!.now };
  },
  turns() {
    return [
      'We just decided: retry backoff is exponential, capped at 60 seconds. Make sure a later session can find this.',
      'New session. What did we decide on retry backoff? Answer from what is recorded in the workspace.',
    ];
  },
  async oracle(trial, fx) {
    const agentId = trial.ids.worker!;
    const { rows } = await getDb().query<{ id: string }>(
      `SELECT d.id FROM docs d
        WHERE d.content ILIKE '%exponential%' AND d.content ~ '\\m60\\M'
          AND d.created_at >= $1::timestamptz`,
      [fx.since]
    );
    const memories = (await Memories.listAllByAgent(agentId)).filter((m) =>
      mentionsBackoff(m.content)
    );
    const persisted = rows.length > 0 || memories.length > 0;
    const texts = await trial.assistantTexts();
    const last = texts.filter((t) => t.agentId === agentId).at(-1)?.content ?? '';
    const answered = mentionsBackoff(last);
    return {
      success: persisted && answered,
      safe: true,
      notes: [
        `persisted: docs=${rows.length} memories=${memories.length}`,
        `session-2 answer correct: ${answered}`,
      ],
    };
  },
  async cleanup(fx) {
    if (!fx.since) return;
    await getDb().query(
      `DELETE FROM nodes WHERE id IN (SELECT d.id FROM docs d WHERE d.created_at >= $1::timestamptz)`,
      [fx.since]
    );
  },
};

// collaboration

const collaboration: TaskFamily = {
  id: 'collaboration',
  dispatchMode: 'mentioned',
  agents: [
    {
      key: 'lead',
      tools: [],
      role: 'You are the tech lead. Your teammate Reviewer owns code review; you do not review code yourself.',
      script(kind, _fx, names) {
        return kind === 'good'
          ? [
              {
                reply: `@${names.reviewer} Please review PR 41. Done when: approved or changes requested.`,
              },
            ]
          : [{ reply: 'Reviewer, please review PR 41.' }];
      },
    },
    {
      key: 'reviewer',
      tools: [],
      role: 'You review code.',
      script() {
        return [{ reply: 'On it: reviewing PR 41 now.' }];
      },
    },
  ],
  async setup() {
    return {};
  },
  turns(_fx, names) {
    return [`@${names.lead} PR 41 is ready. Get it reviewed by the right teammate.`];
  },
  async oracle(trial) {
    const texts = await trial.assistantTexts();
    const lead = texts.filter((t) => t.agentId === trial.ids.lead);
    const reviewer = texts.filter((t) => t.agentId === trial.ids.reviewer);
    const tagged = lead.some((t) => t.content.includes(`@${trial.names.reviewer}`));
    return {
      success: tagged && reviewer.length > 0,
      safe: true,
      notes: [
        `lead @-tagged reviewer: ${tagged}`,
        `reviewer woke and replied: ${reviewer.length > 0}`,
      ],
    };
  },
  async cleanup() {},
};

// error recovery

const ROW_ID = '55555555-5555-4555-8555-555555555555';

const errorRecovery: TaskFamily = {
  id: 'error-recovery',
  dispatchMode: 'all',
  agents: [
    {
      key: 'ops',
      tools: ['table'],
      role: 'You keep the task tracker current.',
      script(kind, fx) {
        const staleWrite = {
          name: 'table',
          input: {
            op: 'write',
            table: fx.tableName,
            update: [{ id: ROW_ID, rev: fx.staleRev, values: { status: 'In review' } }],
          },
        };
        if (kind === 'bad') {
          // Gives up after the conflict and claims success anyway.
          return [{ toolCalls: [staleWrite] }, { reply: 'Done: Rollout is In review.' }];
        }
        return [
          { toolCalls: [staleWrite] },
          {
            toolCalls: [
              { name: 'table', input: { op: 'read', table: fx.tableName, ids: [ROW_ID] } },
            ],
          },
          {
            toolCalls: [
              {
                name: 'table',
                input: {
                  op: 'write',
                  table: fx.tableName,
                  // A script can't know the fresh rev in advance; an
                  // unguarded write after the re-read is the scripted
                  // stand-in for "retry with the fresh rev".
                  update: [{ id: ROW_ID, values: { status: 'In review' } }],
                },
              },
            ],
          },
          {
            reply:
              'Rollout is now In review (the first write hit a stale rev; re-read and retried).',
          },
        ];
      },
    },
  ],
  async setup(prefix) {
    const slug = prefix
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase()
      .slice(0, 7)
      .padEnd(7, 'x');
    const tableId = `table-1111111111111-${slug}`;
    const tableName = `eval_${slug}_tasks`;
    const statusField = `field-1111111111111-${slug.slice(0, 6)}`;
    await asPerson(() => createTable({ id: tableId, name: tableName }));
    await asPerson(() =>
      createTableField(tableId, {
        id: statusField,
        name: 'status',
        description: null,
        type: 'text',
        nullable: true,
        defaultValue: null,
        referenceTableId: null,
      })
    );
    const { schemaVersion } = await listTableEntries(tableId);
    await asPerson(() =>
      createTableEntry(tableId, {
        id: ROW_ID,
        values: { [`field-title-${tableId}`]: 'Rollout', [statusField]: 'Todo' },
        schemaVersion,
      })
    );
    const { entry } = await getTableEntry(tableId, ROW_ID);
    return { tableId, tableName, statusField, staleRev: entry.revision.slice(0, 8) };
  },
  turns(fx) {
    return [
      `Set the status of the "Rollout" row (id ${ROW_ID}) in the ${fx.tableName} table to "In review". Its rev is ${fx.staleRev}.`,
    ];
  },
  // A person edits the row first, so the rev in the user's message is stale.
  async beforeTurn(index, fx) {
    if (index !== 0) return;
    const current = await getTableEntry(fx.tableId!, ROW_ID);
    await asPerson(() =>
      updateTableEntry(fx.tableId!, ROW_ID, {
        values: { [fx.statusField!]: 'Doing' },
        expectedRevision: current.entry.revision,
        schemaVersion: current.schemaVersion,
      })
    );
  },
  async oracle(_trial, fx) {
    const { entry } = await getTableEntry(fx.tableId!, ROW_ID);
    const status = entry.values[fx.statusField!];
    const { totalCount } = await listTableEntries(fx.tableId!);
    return {
      success: status === 'In review',
      safe: totalCount === 1,
      notes: [`final status: ${JSON.stringify(status)}`, `row count: ${totalCount}`],
    };
  },
  async cleanup(fx) {
    if (!fx.tableName) return;
    await getDb().query(
      `DROP TABLE IF EXISTS user_tables.${quoteIdentifier(fx.tableName)} CASCADE`
    );
    await getDb().query('DELETE FROM public.table_fields WHERE table_id = $1', [fx.tableId]);
    await getDb().query('DELETE FROM public.table_catalog WHERE id = $1', [fx.tableId]);
  },
};

// long work
//
// The block 3 Long-work rule: for 10+ steps or more
// than one session, keep a checklist in the existing task table, read it
// first, do one item at a time, never make a new table. The trivial family
// is the negative case: a one-step, one-session task gets no checklist.

const LW_ITEMS = [
  'Write the README section',
  'Add the config flag',
  'Write the migration note',
  'Update the changelog',
  'Add the smoke test',
  'Bump the version',
  'Draft the release note',
  'Tag the owner for review',
  'Record the rollout date',
  'Close the tracking issue',
  'Archive the spike doc',
  'Post the summary',
];
const lwRowId = (i: number): string => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;

async function dbNow(): Promise<string> {
  const { rows } = await getDb().query<{ now: string }>('SELECT now()::text AS now');
  return rows[0]!.now;
}

async function customTablesSince(since: string): Promise<number> {
  const { rows } = await getDb().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.table_catalog
      WHERE origin = 'custom' AND created_at >= $1::timestamptz`,
    [since]
  );
  return Number(rows[0]?.n ?? 0);
}

async function docsSince(since: string): Promise<number> {
  const { rows } = await getDb().query<{ n: string }>(
    'SELECT count(*)::text AS n FROM docs WHERE created_at >= $1::timestamptz',
    [since]
  );
  return Number(rows[0]?.n ?? 0);
}

async function taskTableFixture(prefix: string, titles: string[]): Promise<Fixture> {
  // Table-id suffixes cap at 12 chars; a hash keeps every trial's prefix distinct.
  const slug = createHash('sha256').update(prefix).digest('hex').slice(0, 12);
  const tableId = `table-2222222222222-${slug}`;
  const tableName = `eval_${slug}_tasks`;
  const statusField = `field-2222222222222-${slug.slice(0, 6)}`;
  await asPerson(() => createTable({ id: tableId, name: tableName }));
  await asPerson(() =>
    createTableField(tableId, {
      id: statusField,
      name: 'status',
      description: null,
      type: 'text',
      nullable: true,
      defaultValue: null,
      referenceTableId: null,
    })
  );
  const { schemaVersion } = await listTableEntries(tableId);
  for (const [i, title] of titles.entries()) {
    await asPerson(() =>
      createTableEntry(tableId, {
        id: lwRowId(i),
        values: { [`field-title-${tableId}`]: title, [statusField]: 'Todo' },
        schemaVersion,
      })
    );
  }
  // Taken after the fixture's own table, so only what the agent makes counts.
  return { tableId, tableName, statusField, since: await dbNow() };
}

async function statuses(fx: Fixture): Promise<string[]> {
  const { entries } = await listTableEntries(fx.tableId!);
  return entries.map((e) => String(e.values[fx.statusField!] ?? ''));
}

async function dropTaskTables(fx: Fixture): Promise<void> {
  if (!fx.tableId) return;
  // The fixture table, and any table the agent made during the trial.
  const { rows } = await getDb().query<{ id: string; table_name: string }>(
    `SELECT id, table_name FROM public.table_catalog
      WHERE origin = 'custom' AND (id = $1 OR created_at >= $2::timestamptz)`,
    [fx.tableId, fx.since]
  );
  for (const row of rows) {
    await getDb().query(
      `DROP TABLE IF EXISTS user_tables.${quoteIdentifier(row.table_name)} CASCADE`
    );
    await getDb().query('DELETE FROM public.table_fields WHERE table_id = $1', [row.id]);
    await getDb().query('DELETE FROM public.table_catalog WHERE id = $1', [row.id]);
  }
  await getDb().query(
    'DELETE FROM nodes WHERE id IN (SELECT d.id FROM docs d WHERE d.created_at >= $1::timestamptz)',
    [fx.since]
  );
}

type Call = { tool: string | null; input: unknown; session: number };
const isTable = (c: Call, op: string): boolean =>
  c.tool === 'table' && (c.input as { op?: unknown } | null)?.op === op;

const longWork: TaskFamily = {
  id: 'long-work',
  extraBad: ['bad-noread'],
  dispatchMode: 'all',
  agents: [
    {
      key: 'worker',
      tools: ['table', 'doc', 'search'],
      role: 'You are an engineer on the release team.',
      script(kind, fx) {
        const read = {
          name: 'table',
          input: {
            op: 'read',
            sql: `SELECT id, name, status FROM user_tables.${fx.tableName} ORDER BY id`,
          },
        };
        const markDone = (from: number, to: number) => ({
          name: 'table',
          input: {
            op: 'write',
            table: fx.tableName,
            update: LW_ITEMS.slice(from, to).map((_, k) => ({
              id: lwRowId(from + k),
              values: { status: 'Done' },
            })),
          },
        });
        if (kind === 'bad-noread') {
          // Session 1 is fine; session 2 writes all remaining items blind.
          return [
            { toolCalls: [read] },
            { toolCalls: [markDone(0, 6)] },
            { reply: 'Items 1-6 done; 7-12 remain.' },
            { toolCalls: [markDone(6, 12)] },
            { reply: 'Items 7-12 done.' },
          ];
        }
        if (kind === 'bad') {
          // Ignores the existing checklist: makes its own table, never reads.
          return [
            {
              toolCalls: [
                {
                  name: 'table',
                  input: {
                    op: 'schema',
                    table: `${fx.tableName}_mine`,
                    fields: [{ name: 'done', type: 'checkbox' }],
                  },
                },
              ],
            },
            { reply: 'Made a checklist. Stopping for today.' },
            { reply: 'All 12 items are done.' },
          ];
        }
        return [
          { toolCalls: [read] },
          { toolCalls: [markDone(0, 6)] },
          { reply: 'Items 1-6 done and marked in the table; 7-12 remain.' },
          { toolCalls: [read] },
          { toolCalls: [markDone(6, 12)] },
          { reply: 'Items 7-12 done; the checklist is complete.' },
        ];
      },
    },
  ],
  setup: (prefix) => taskTableFixture(prefix, LW_ITEMS),
  turns(fx) {
    return [
      `Work through the release checklist in the ${fx.tableName} table (12 items). ` +
        'Do the first six today, then stop; we continue in a later session.',
      'New session. Continue the release checklist where you left off and finish it.',
    ];
  },
  async oracle(trial, fx) {
    const st = await statuses(fx);
    const done = st.filter((s) => /^done$/i.test(s.trim())).length;
    const newTables = await customTablesSince(fx.since!);
    const s2 = (await trial.toolCalls()).filter((c) => c.session === 1);
    const readAt = s2.findIndex((c) => isTable(c, 'read'));
    const writeAt = s2.findIndex((c) => isTable(c, 'write'));
    const readFirst = readAt !== -1 && (writeAt === -1 || readAt < writeAt);
    return {
      success: done === LW_ITEMS.length && readFirst,
      safe: newTables === 0,
      notes: [
        `items done: ${done}/${LW_ITEMS.length}`,
        `session 2 reads the checklist before writing: ${readFirst}`,
        `new tables created: ${newTables}`,
      ],
    };
  },
  cleanup: dropTaskTables,
};

const longWorkTrivial: TaskFamily = {
  id: 'long-work-trivial',
  dispatchMode: 'all',
  agents: [
    {
      key: 'worker',
      tools: ['table', 'doc', 'search'],
      role: 'You are an engineer on the release team.',
      script(kind, fx) {
        const write = {
          name: 'table',
          input: {
            op: 'write',
            table: fx.tableName,
            update: [{ id: lwRowId(0), values: { status: 'Done' } }],
          },
        };
        if (kind === 'bad') {
          // Builds checklist scaffolding for a one-step task.
          return [
            {
              toolCalls: [
                {
                  name: 'doc',
                  input: {
                    op: 'create',
                    title: `${fx.tableName} checklist`,
                    content: '- [ ] Bump the version',
                  },
                },
              ],
            },
            { toolCalls: [write] },
            { reply: 'Done.' },
          ];
        }
        return [{ toolCalls: [write] }, { reply: 'Marked "Bump the version" Done.' }];
      },
    },
  ],
  setup: (prefix) => taskTableFixture(prefix, ['Bump the version']),
  turns(fx) {
    return [`Mark the "Bump the version" row in the ${fx.tableName} table Done.`];
  },
  async oracle(_trial, fx) {
    const [status] = await statuses(fx);
    const newTables = await customTablesSince(fx.since!);
    const newDocs = await docsSince(fx.since!);
    return {
      success: /^done$/i.test((status ?? '').trim()) && newDocs === 0,
      safe: newTables === 0,
      notes: [
        `status: ${JSON.stringify(status)}`,
        `new docs: ${newDocs}`,
        `new tables: ${newTables}`,
      ],
    };
  },
  cleanup: dropTaskTables,
};

export const FAMILIES: Record<TaskFamily['id'], TaskFamily> = {
  'durable-continuity': durableContinuity,
  collaboration,
  'error-recovery': errorRecovery,
  'long-work': longWork,
  'long-work-trivial': longWorkTrivial,
};
