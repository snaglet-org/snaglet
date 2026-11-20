/**
 * candidateCards — shadow evidence. Pins the contracts that matter:
 * scope-fit resolution (thread/project/out-of-scope/global), the freshness
 * heuristic (including archived ⇒ stale), novelty against caller context,
 * node lifecycle/completion (docs read 'active' with no due date), and the
 * batched-SQL constraint (query count must not grow with candidate count).
 */

import { beforeEach, describe, expect, it } from '@jest/globals';

interface MockRow {
  [key: string]: unknown;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-07-01T12:00:00Z').getTime();
const daysAgo = (days: number) => new Date(NOW - days * DAY_MS);

/** Fixture rows keyed by which batched query consumes them. */
const fixtures: Record<string, MockRow[]> = {
  nodes: [],
  links: [],
  threads: [],
  walk: [],
  summaries: [],
  memories: [],
  messages: [],
};

const dbQuery = jest.fn(async (sql: string) => {
  if (sql.includes('WITH RECURSIVE walk')) return { rows: fixtures.walk };
  if (sql.includes('FROM public.thread_summaries')) return { rows: fixtures.summaries };
  if (sql.includes('FROM public.memories')) return { rows: fixtures.memories };
  if (sql.includes('FROM public.messages')) return { rows: fixtures.messages };
  if (sql.includes('FROM public.nodes WHERE id')) return { rows: fixtures.nodes };
  if (sql.includes('FROM public.links')) return { rows: fixtures.links };
  if (sql.includes('FROM public.threads')) return { rows: fixtures.threads };
  throw new Error(`unmocked query: ${sql.slice(0, 80)}`);
});

jest.mock('@snaglet/db', () => ({
  getDb: () => ({ query: (sql: string, params?: unknown[]) => dbQuery(sql, params) }),
}));
jest.mock('@server/config/logger.js', () => ({
  logger: { debug: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { buildCandidateCards, toCardCandidate } from '@server/services/search/candidateCards';

const nodeRow = (id: string, type: string, overrides: Partial<MockRow> = {}): MockRow => ({
  id,
  type,
  created_at: daysAgo(30),
  updated_at: daysAgo(30),
  archived: false,
  container_id: null,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(fixtures)) fixtures[key] = [];
});

describe('candidateCards', () => {
  it('resolves scope fit: current thread, current project, out of scope, global', async () => {
    fixtures.nodes = [
      nodeRow('doc-in', 'doc', { container_id: 'cont-a', updated_at: daysAgo(2) }),
      nodeRow('doc-out', 'doc', { container_id: 'cont-b' }),
      nodeRow('mem-1', 'memory'),
    ];
    fixtures.walk = [
      { seed_id: 'cont-a', container_id: 'cont-a', depth: 0, project_id: 'project-p' },
      { seed_id: 'cont-b', container_id: 'cont-b', depth: 0, project_id: 'project-q' },
    ];
    fixtures.memories = [
      { id: 'mem-1', agent_id: 'agent-1', source_thread_id: null, created_at: daysAgo(3) },
    ];
    fixtures.messages = [
      { id: 'msg-1', thread_id: 'thread-ctx', agent_id: null, user_id: 7, created_at: daysAgo(1) },
    ];
    fixtures.threads = [{ id: 'thread-ctx', last_message_at: daysAgo(1) }];

    const cards = await buildCandidateCards(
      [
        { id: 'doc-in', kind: 'doc', rank: 1 },
        { id: 'doc-out', kind: 'doc', rank: 2 },
        { id: 'msg-1', kind: 'message', rank: 3, threadId: 'thread-ctx' },
        { id: 'mem-1', kind: 'memory', rank: 4 },
      ],
      { threadId: 'thread-ctx', projectId: 'project-p', now: NOW }
    );

    expect(cards.get('doc-in')?.scope.scopeFit).toBe('current_project');
    expect(cards.get('doc-out')?.scope.scopeFit).toBe('out_of_scope');
    expect(cards.get('msg-1')?.scope.scopeFit).toBe('current_thread');
    expect(cards.get('mem-1')?.scope.scopeFit).toBe('global');
    // Message provenance comes from its own row.
    expect(cards.get('msg-1')?.provenance.sourceThreadId).toBe('thread-ctx');
  });

  it('maps freshness: fresh, recently_referenced, possibly_stale, archived ⇒ stale', async () => {
    fixtures.nodes = [
      nodeRow('doc-fresh', 'doc', { updated_at: daysAgo(2) }),
      nodeRow('doc-ref', 'doc', { updated_at: daysAgo(30) }),
      nodeRow('doc-old', 'doc', { updated_at: daysAgo(120) }),
      nodeRow('doc-arch', 'doc', { updated_at: daysAgo(1), archived: true }),
    ];
    fixtures.links = [
      {
        source_id: 'thread-x',
        target_id: 'doc-ref',
        relation: 'references',
        created_at: daysAgo(5),
        source_kind: 'thread',
        target_kind: 'doc',
      },
    ];

    const cards = await buildCandidateCards(
      [
        { id: 'doc-fresh', kind: 'doc' },
        { id: 'doc-ref', kind: 'doc' },
        { id: 'doc-old', kind: 'doc' },
        { id: 'doc-arch', kind: 'doc' },
      ],
      { now: NOW }
    );

    expect(cards.get('doc-fresh')?.freshness.freshnessFit).toBe('fresh');
    expect(cards.get('doc-ref')?.freshness.freshnessFit).toBe('recently_referenced');
    expect(cards.get('doc-old')?.freshness.freshnessFit).toBe('possibly_stale');
    expect(cards.get('doc-arch')?.freshness.freshnessFit).toBe('stale');
    expect(cards.get('doc-arch')?.status.lifecycle).toBe('archived');
    expect(cards.get('doc-ref')?.links).toHaveLength(1);
    expect(cards.get('doc-ref')?.links[0]).toMatchObject({
      direction: 'incoming',
      relation: 'references',
      linkedNodeId: 'thread-x',
    });
  });

  it('maps node lifecycle and completion; superseded summaries read stale', async () => {
    // Tasks are docs (no task status column). A non-archived node reads
    // 'active', completion is always false, and there is no due date.
    fixtures.nodes = [nodeRow('doc-1', 'doc'), nodeRow('sum-1', 'thread_summary')];
    fixtures.summaries = [
      {
        id: 'sum-1',
        thread_id: 'thread-s',
        agent_id: 'agent-1',
        is_current: false,
        last_message_id: 'message-99',
        created_at: daysAgo(10),
      },
    ];
    fixtures.threads = [{ id: 'thread-s', last_message_at: daysAgo(2) }];

    const cards = await buildCandidateCards(
      [
        { id: 'doc-1', kind: 'doc' },
        { id: 'sum-1', kind: 'thread_summary' },
      ],
      { now: NOW }
    );

    expect(cards.get('doc-1')?.status.lifecycle).toBe('active');
    expect(cards.get('doc-1')?.status.isCompleted).toBe(false);
    expect(cards.get('doc-1')?.freshness.dueAt).toBeNull();
    expect(cards.get('sum-1')?.status.isSuperseded).toBe(true);
    expect(cards.get('sum-1')?.freshness.freshnessFit).toBe('stale');
    expect(cards.get('sum-1')?.provenance.sourceMessageId).toBe('message-99');
    expect(cards.get('sum-1')?.provenance.evidenceStrength).toBe('strong');
  });

  it('derives the nearest project from the ancestor walk and nothing else', async () => {
    fixtures.nodes = [
      nodeRow('doc-in-project', 'doc', { container_id: 'proj-folder', updated_at: daysAgo(200) }),
      nodeRow('doc-b', 'doc', {
        container_id: 'folder-b',
        updated_at: daysAgo(200),
      }),
      nodeRow('doc-c', 'doc', { container_id: 'folder-c', updated_at: daysAgo(200) }),
      nodeRow('ref-doc', 'doc', { container_id: 'ref-cont', updated_at: daysAgo(200) }),
      nodeRow('plain-doc', 'doc', { container_id: 'plain-cont', updated_at: daysAgo(200) }),
    ];
    // Ancestor chains (depth-ASC): the nearest project container names the
    // scope. There are no status containers or phases, and no container
    // annotation exempts anything from freshness.
    fixtures.walk = [
      {
        seed_id: 'proj-folder',
        container_id: 'proj-folder',
        depth: 0,
        category: null,
        project_id: null,
      },
      {
        seed_id: 'proj-folder',
        container_id: 'proj',
        depth: 1,
        category: 'project',
        project_id: 'proj',
      },
      {
        seed_id: 'folder-b',
        container_id: 'folder-b',
        depth: 0,
        category: null,
        project_id: null,
      },
      {
        seed_id: 'folder-c',
        container_id: 'folder-c',
        depth: 0,
        category: null,
        project_id: null,
      },
      {
        seed_id: 'ref-cont',
        container_id: 'ref-cont',
        depth: 0,
        category: null,
        project_id: null,
      },
      {
        seed_id: 'plain-cont',
        container_id: 'plain-cont',
        depth: 0,
        category: null,
        project_id: null,
      },
    ];

    const cards = await buildCandidateCards(
      [
        { id: 'doc-in-project', kind: 'doc' },
        { id: 'doc-b', kind: 'doc' },
        { id: 'doc-c', kind: 'doc' },
        { id: 'ref-doc', kind: 'doc' },
        { id: 'plain-doc', kind: 'doc' },
      ],
      { now: NOW }
    );

    expect(cards.get('doc-in-project')?.scope.projectId).toBe('proj');
    expect(cards.get('doc-b')?.scope.projectId).toBeNull();
    expect(cards.get('doc-c')?.scope.projectId).toBeNull();
    expect(cards.get('plain-doc')?.scope.projectId).toBeNull();
    expect(cards.get('doc-in-project')?.status).not.toHaveProperty('lifecyclePhase');

    // No freshness exemption appears on the card: no container category
    // switches off staleness decay for its descendants. Asserting the absence
    // of the specific fields rather than the block's whole key list, so
    // unrelated freshness signals can be added without breaking this.
    for (const id of ['ref-doc', 'plain-doc']) {
      const freshness = cards.get(id)!.freshness;
      expect(freshness).not.toHaveProperty('timelessExempt');
      expect(freshness).not.toHaveProperty('referenceExempt');
      // Both docs are the same age, so both get the same verdict — the point
      // being that nothing about their containers changes it.
      expect(freshness.freshnessFit).toBe(cards.get('plain-doc')!.freshness.freshnessFit);
    }
  });

  it('gives a deeply nested doc ordinary freshness (no container exempts its subtree)', async () => {
    // A doc nested several levels under a container is aged like any other
    // document; no container annotation exempts a subtree.
    fixtures.nodes = [
      {
        id: 'deep-doc',
        type: 'doc',
        container_id: 'leaf',
        archived: false,
        updated_at: new Date(NOW - 400 * 86_400_000).toISOString(),
      },
    ];
    fixtures.walk = [
      {
        seed_id: 'leaf',
        container_id: 'leaf',
        depth: 0,
        category: null,
        project_id: null,
      },
      {
        seed_id: 'leaf',
        container_id: 'mid',
        depth: 1,
        category: null,
        project_id: null,
      },
      // A plain container with no special power over its descendants' ranking.
      {
        seed_id: 'leaf',
        container_id: 'canon',
        depth: 2,
        category: null,
        project_id: null,
      },
    ];

    const card = (await buildCandidateCards([{ id: 'deep-doc', kind: 'doc' }], { now: NOW })).get(
      'deep-doc'
    );

    // A 400-day-old doc is stale, full stop — no ancestor rescues it.
    expect(card?.freshness.freshnessFit).toBe('stale');
    expect(card?.freshness).not.toHaveProperty('timelessExempt');
    expect(card?.freshness).not.toHaveProperty('referenceExempt');
  });

  it('computes novelty from caller-supplied visible/recent ids', async () => {
    fixtures.nodes = [
      nodeRow('doc-dup', 'doc'),
      nodeRow('doc-recent', 'doc'),
      nodeRow('doc-new', 'doc'),
    ];

    const cards = await buildCandidateCards(
      [
        { id: 'doc-dup', kind: 'doc' },
        { id: 'doc-recent', kind: 'doc' },
        { id: 'doc-new', kind: 'doc' },
      ],
      { visibleNodeIds: ['doc-dup'], recentNodeIds: ['doc-recent'], now: NOW }
    );

    expect(cards.get('doc-dup')?.novelty).toMatchObject({
      alreadyInCurrentPrompt: true,
      novelty: 'duplicate',
    });
    expect(cards.get('doc-recent')?.novelty).toMatchObject({
      recentlyReferencedByAgent: true,
      novelty: 'new_useful_context',
    });
    expect(cards.get('doc-new')?.novelty.novelty).toBe('new_useful_context');

    // Without context arrays, novelty is unknown rather than a guess.
    const blind = await buildCandidateCards([{ id: 'doc-new', kind: 'doc' }], { now: NOW });
    expect(blind.get('doc-new')?.novelty.novelty).toBe('unknown');
  });

  it('keeps SQL batched: query count does not grow with candidate count', async () => {
    fixtures.nodes = [nodeRow('doc-1', 'doc', { container_id: 'cont-a' })];
    fixtures.walk = [{ seed_id: 'cont-a', container_id: 'cont-a', depth: 0, project_id: null }];

    await buildCandidateCards([{ id: 'doc-1', kind: 'doc' }], { now: NOW });
    const single = dbQuery.mock.calls.length;

    jest.clearAllMocks();
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `doc-${i}`,
      kind: i % 4 === 0 ? 'message' : i % 4 === 1 ? 'thread' : i % 4 === 2 ? 'memory' : 'doc',
    }));
    await buildCandidateCards(many, { threadId: 'thread-ctx', now: NOW });
    // Per-kind detail queries may join in, but the count is bounded by the
    // number of query kinds (~10), never by the number of candidates.
    expect(dbQuery.mock.calls.length).toBeLessThanOrEqual(single + 8);
  });

  it('never throws: a query failure yields an empty map, not an error', async () => {
    dbQuery.mockRejectedValueOnce(new Error('connection refused'));
    const cards = await buildCandidateCards([{ id: 'doc-1', kind: 'doc' }], { now: NOW });
    expect(cards.size).toBe(0);
  });

  it('toCardCandidate extracts anchor fields from hit-shaped objects', () => {
    expect(
      toCardCandidate(
        { id: 'msg-1', kind: 'message', threadId: 'thread-9', score: 0.4, channels: ['vector'] },
        3
      )
    ).toMatchObject({
      id: 'msg-1',
      kind: 'message',
      rank: 3,
      threadId: 'thread-9',
      score: 0.4,
      channels: ['vector'],
    });
  });
});
