/**
 * memoryExtraction — compaction-time durable-fact extraction (unit).
 *
 * Provider call, DB models, and MemoryService are all mocked; these tests
 * pin the module's contracts:
 *  - agent facts auto-save active with verified=false
 *  - member facts save only as inert proposals (status='proposed'), never
 *    as an active member memory
 *  - the compacted span is the slice between summary-version boundaries
 *  - malformed model output degrades to zero candidates, never an error
 *  - the 3-candidate cap (enforced in code), strict scope validation,
 *    tolerant kind handling, kind-prefixed key normalization
 *  - every failure mode resolves (never rejects) — compaction safety
 *  - unusable first output (blank or no JSON array) retries exactly once
 *    with the simplified prompt; a deliberate `[]` never retries
 */

import { beforeEach, describe, expect, it } from '@jest/globals';

const listByThreadId = jest.fn();
const getHistoryByThreadAndAgent = jest.fn();
const listByThread = jest.fn();
const storeMemory = jest.fn();
const resolveUtilityModel = jest.fn();
const generateUtilityText = jest.fn();

jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { listByThreadId: (...args: unknown[]) => listByThreadId(...args) },
}));

jest.mock('@snaglet/db/tables/thread_summaries', () => ({
  ThreadSummaries: {
    getHistoryByThreadAndAgent: (...args: unknown[]) => getHistoryByThreadAndAgent(...args),
  },
}));

jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: { listByThread: (...args: unknown[]) => listByThread(...args) },
}));

jest.mock('@server/services/MemoryService', () => ({
  memoryService: { store: (...args: unknown[]) => storeMemory(...args) },
}));

jest.mock('@server/services/summary/UtilityModelResolver', () => ({
  resolveUtilityModel: (...args: unknown[]) => resolveUtilityModel(...args),
}));

jest.mock('@server/services/summary/generateUtilityText', () => ({
  generateUtilityText: (...args: unknown[]) => generateUtilityText(...args),
}));

import {
  DEFAULT_MEMORY_KIND,
  MEMORY_EXTRACTION_INSTRUCTIONS,
  MEMORY_EXTRACTION_MAX_CANDIDATES,
  MEMORY_KINDS,
  SIMPLE_MEMORY_EXTRACTION_INSTRUCTIONS,
  applyKindPrefix,
  extractMemoriesFromCompaction,
  normalizeMemoryKey,
  normalizeMemoryKind,
  parseExtractionResponse,
} from '@server/services/summary/memoryExtraction';

const THREAD = 'thread-1';
const AGENT = 'agent-1';

const resolvedModel = {
  providerId: 'anthropic',
  modelId: 'claude-test',
  credentialId: null,
  isLocal: false,
  maxInputChars: 60_000,
  timeoutMs: 60_000,
  source: 'own-model',
};

function msg(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  messageType: 'message' | 'thread_event' = 'message'
) {
  return {
    id,
    threadId: THREAD,
    role,
    agentId: role === 'assistant' ? AGENT : null,
    userId: null,
    content,
    messageType,
    resolved: false,
    metadata: {},
    runId: null,
    createdAt: `2026-08-10T00:00:00.00${id.slice(1)}Z`,
  };
}

const candidatesJson = JSON.stringify([
  {
    key: 'Db Mode',
    content: 'The database runs in external mode via a shared socket.',
    scope: 'agent',
    kind: 'connection',
  },
  {
    // Already carries its own kind prefix: the prefixing must be idempotent.
    key: 'user-short-reports',
    content: 'Test User prefers short reports in plain language.',
    scope: 'member',
    kind: 'user',
  },
]);

/** The result shape with every counter at zero. */
const NO_MEMORIES = { saved: 0, proposed: 0, duplicates: 0, dropped: 0 };

describe('extractMemoriesFromCompaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Two summary versions: v2 (current) covers m3..m4, v1 covered ..m2.
    getHistoryByThreadAndAgent.mockResolvedValue([
      { id: 'sum-2', version: 2, isCurrent: true, lastMessageId: 'm4' },
      { id: 'sum-1', version: 1, isCurrent: false, lastMessageId: 'm2' },
    ]);
    listByThreadId.mockResolvedValue([
      msg('m1', 'user', 'old covered message about llamas'),
      msg('m2', 'assistant', 'old covered reply about llamas'),
      msg('m3', 'user', 'we switched the database to external mode'),
      msg('m4', 'assistant', 'confirmed, external mode it is'),
      msg('m5', 'user', 'newer message beyond the summary boundary'),
    ]);
    resolveUtilityModel.mockResolvedValue({ ok: true, model: resolvedModel });
    generateUtilityText.mockResolvedValue(candidatesJson);
    listByThread.mockResolvedValue([
      { id: 'tp-1', threadId: THREAD, memberId: 'member-user-1', kind: 'user', agentId: null },
      { id: 'tp-2', threadId: THREAD, memberId: 'member-agent-1', kind: 'agent', agentId: AGENT },
    ]);
    storeMemory.mockResolvedValue({ id: 'memory-x', key: 'k', isDuplicate: false });
  });

  it('saves agent facts as active verified=false memories and member facts as inert proposals', async () => {
    const result = await extractMemoriesFromCompaction({ threadId: THREAD, agentId: AGENT });

    expect(result).toEqual({ saved: 1, proposed: 1, duplicates: 0, dropped: 0 });
    expect(storeMemory).toHaveBeenCalledTimes(2);
    expect(storeMemory).toHaveBeenCalledWith({
      agentId: AGENT,
      threadId: THREAD,
      // kind 'connection' is persisted as the key prefix — no new column.
      key: 'connection-db-mode',
      content: 'The database runs in external mode via a shared socket.',
      verified: false,
      status: 'active',
    });
    expect(storeMemory).toHaveBeenCalledWith({
      memberId: 'member-user-1',
      threadId: THREAD,
      // Already prefixed by the model: not rewritten to 'user-user-…'.
      key: 'user-short-reports',
      content: 'Test User prefers short reports in plain language.',
      verified: false,
      status: 'proposed',
    });

    // The invariant: no store call ever writes an active member memory.
    for (const [input] of storeMemory.mock.calls as Array<
      [{ memberId?: string; status?: string }]
    >) {
      if (input.memberId) expect(input.status).toBe('proposed');
    }
  });

  it('sends only the span between the previous and current summary boundaries to the model', async () => {
    await extractMemoriesFromCompaction({ threadId: THREAD, agentId: AGENT });

    const [, args] = generateUtilityText.mock.calls[0] as [unknown, { userMessage: string }];
    expect(args.userMessage).toContain('external mode');
    expect(args.userMessage).toContain('confirmed');
    expect(args.userMessage).not.toContain('llamas');
    expect(args.userMessage).not.toContain('beyond the summary boundary');
  });

  it('mines exactly the folded units when given them, without reading the summary history', async () => {
    listByThreadId.mockResolvedValue([
      { ...msg('m1', 'user', 'a user message inside a folded unit'), runId: null },
      { ...msg('m2', 'assistant', 'a reply that belongs to a folded run'), runId: 'run-folded' },
      msg('m3', 'user', 'a later message that was not folded'),
      { ...msg('m4', 'assistant', 'a reply from a run that was not folded'), runId: 'run-kept' },
    ]);
    getHistoryByThreadAndAgent.mockClear();

    await extractMemoriesFromCompaction({
      threadId: THREAD,
      agentId: AGENT,
      foldedUnitIds: ['m1', 'run-folded'],
    });

    const [, args] = generateUtilityText.mock.calls[0] as [unknown, { userMessage: string }];
    expect(args.userMessage).toContain('a user message inside a folded unit');
    expect(args.userMessage).toContain('a reply that belongs to a folded run');
    expect(args.userMessage).not.toContain('a later message that was not folded');
    expect(args.userMessage).not.toContain('a reply from a run that was not folded');
    expect(getHistoryByThreadAndAgent).not.toHaveBeenCalled();
  });

  it('mines a folded standalone assistant row (no run) by its message id', async () => {
    listByThreadId.mockResolvedValue([
      { ...msg('m1', 'assistant', 'a hook post folded with no run'), runId: null },
      { ...msg('m2', 'assistant', 'a reply that belongs to a folded run'), runId: 'run-folded' },
      { ...msg('m3', 'assistant', 'a standalone row that was not folded'), runId: null },
    ]);

    // historyCompactor reports a standalone unit by its message id (the replay sortId prefix
    // `__standalone:` is stripped), so the row is found here.
    await extractMemoriesFromCompaction({
      threadId: THREAD,
      agentId: AGENT,
      foldedUnitIds: ['m1', 'run-folded'],
    });

    const [, args] = generateUtilityText.mock.calls[0] as [unknown, { userMessage: string }];
    expect(args.userMessage).toContain('a hook post folded with no run');
    expect(args.userMessage).toContain('a reply that belongs to a folded run');
    expect(args.userMessage).not.toContain('a standalone row that was not folded');
  });

  it('mines nothing when the folded units hold no messages', async () => {
    const result = await extractMemoriesFromCompaction({
      threadId: THREAD,
      agentId: AGENT,
      foldedUnitIds: ['no-such-unit'],
    });
    expect(result).toEqual(NO_MEMORIES);
    expect(generateUtilityText).not.toHaveBeenCalled();
  });

  it('excludes thread_event narration from the mined span', async () => {
    listByThreadId.mockResolvedValue([
      msg('m1', 'user', 'old covered message'),
      msg('m2', 'assistant', 'old covered reply'),
      msg('m3', 'user', 'roster changed: quokka joined', 'thread_event'),
      msg('m4', 'assistant', 'real reply inside the span'),
    ]);

    await extractMemoriesFromCompaction({ threadId: THREAD, agentId: AGENT });

    const [, args] = generateUtilityText.mock.calls[0] as [unknown, { userMessage: string }];
    expect(args.userMessage).toContain('real reply inside the span');
    expect(args.userMessage).not.toContain('quokka joined');
  });

  it('a fresh single-version summary mines the thread from the beginning', async () => {
    getHistoryByThreadAndAgent.mockResolvedValue([
      { id: 'sum-1', version: 1, isCurrent: true, lastMessageId: 'm4' },
    ]);

    await extractMemoriesFromCompaction({ threadId: THREAD, agentId: AGENT });

    const [, args] = generateUtilityText.mock.calls[0] as [unknown, { userMessage: string }];
    expect(args.userMessage).toContain('llamas');
    expect(args.userMessage).not.toContain('beyond the summary boundary');
  });

  it('malformed model output yields zero candidates and zero stores, without throwing', async () => {
    generateUtilityText.mockResolvedValue('Sorry, I cannot produce JSON today.');

    const result = await extractMemoriesFromCompaction({ threadId: THREAD, agentId: AGENT });

    expect(result).toEqual(NO_MEMORIES);
    expect(storeMemory).not.toHaveBeenCalled();
  });

  describe('single-retry discipline (unusable first output)', () => {
    it('empty-then-good: retries once with the simplified prompt and proceeds', async () => {
      generateUtilityText.mockResolvedValueOnce('   \n').mockResolvedValueOnce(candidatesJson);

      const result = await extractMemoriesFromCompaction({ threadId: THREAD, agentId: AGENT });

      expect(result).toEqual({ saved: 1, proposed: 1, duplicates: 0, dropped: 0 });
      expect(generateUtilityText).toHaveBeenCalledTimes(2);
      const [, firstArgs] = generateUtilityText.mock.calls[0] as [
        unknown,
        { system: string; userMessage: string },
      ];
      const [, retryArgs] = generateUtilityText.mock.calls[1] as [
        unknown,
        { system: string; userMessage: string },
      ];
      expect(firstArgs.system).toBe(MEMORY_EXTRACTION_INSTRUCTIONS);
      expect(retryArgs.system).toBe(SIMPLE_MEMORY_EXTRACTION_INSTRUCTIONS);
      // Same packed span both times — only the instructions are simplified.
      expect(retryArgs.userMessage).toBe(firstArgs.userMessage);
    });

    it('empty-then-empty: yields zero candidates after exactly two calls', async () => {
      generateUtilityText.mockResolvedValueOnce('').mockResolvedValueOnce('  ');

      const result = await extractMemoriesFromCompaction({ threadId: THREAD, agentId: AGENT });

      expect(result).toEqual(NO_MEMORIES);
      expect(generateUtilityText).toHaveBeenCalledTimes(2);
      expect(storeMemory).not.toHaveBeenCalled();
    });

    it('a valid [] first answer is a decision: no retry', async () => {
      generateUtilityText.mockResolvedValue('[]');

      const result = await extractMemoriesFromCompaction({ threadId: THREAD, agentId: AGENT });

      expect(result).toEqual(NO_MEMORIES);
      expect(generateUtilityText).toHaveBeenCalledTimes(1);
    });

    it('a well-formed array of invalid items is a decision: no retry', async () => {
      generateUtilityText.mockResolvedValue('[{"key": 42}]');

      const result = await extractMemoriesFromCompaction({ threadId: THREAD, agentId: AGENT });

      expect(result).toEqual(NO_MEMORIES);
      expect(generateUtilityText).toHaveBeenCalledTimes(1);
    });

    it('malformed-JSON first answer retries (same failure class as blank)', async () => {
      generateUtilityText
        .mockResolvedValueOnce('Sorry, I cannot produce JSON today.')
        .mockResolvedValueOnce(candidatesJson);

      const result = await extractMemoriesFromCompaction({ threadId: THREAD, agentId: AGENT });

      expect(result).toEqual({ saved: 1, proposed: 1, duplicates: 0, dropped: 0 });
      expect(generateUtilityText).toHaveBeenCalledTimes(2);
    });

    it('a throw on the retry call is contained: resolves empty, never rejects', async () => {
      generateUtilityText
        .mockResolvedValueOnce('')
        .mockRejectedValueOnce(new Error('provider exploded on retry'));

      await expect(
        extractMemoriesFromCompaction({ threadId: THREAD, agentId: AGENT })
      ).resolves.toEqual(NO_MEMORIES);
      expect(storeMemory).not.toHaveBeenCalled();
    });
  });

  it('the per-compaction cap is 3', () => {
    // The cap is a fixed number, not a vibe: pin it so a prompt edit
    // cannot quietly widen the cap.
    expect(MEMORY_EXTRACTION_MAX_CANDIDATES).toBe(3);
  });

  it(`caps extraction at ${MEMORY_EXTRACTION_MAX_CANDIDATES} candidates, truncating the rest`, async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      key: `fact-${i}`,
      content: `Durable fact number ${i}.`,
      scope: 'agent',
      kind: 'understanding',
    }));
    generateUtilityText.mockResolvedValue(JSON.stringify(many));

    const result = await extractMemoriesFromCompaction({ threadId: THREAD, agentId: AGENT });

    expect(storeMemory).toHaveBeenCalledTimes(MEMORY_EXTRACTION_MAX_CANDIDATES);
    expect(result.saved).toBe(MEMORY_EXTRACTION_MAX_CANDIDATES);
    // Truncation keeps the first three (the model is told most-valuable
    // first), so fact-0..2 land and fact-3.. do not.
    const keys = (storeMemory.mock.calls as Array<[{ key: string }]>).map(([input]) => input.key);
    expect(keys).toEqual(['understanding-fact-0', 'understanding-fact-1', 'understanding-fact-2']);
  });

  it('tolerates a missing or unknown kind instead of dropping the candidate', async () => {
    generateUtilityText.mockResolvedValue(
      JSON.stringify([
        { key: 'no-kind-at-all', content: 'Durable fact with no kind field.', scope: 'agent' },
        {
          key: 'bogus-kind',
          content: 'Durable fact with an invented kind.',
          scope: 'agent',
          kind: 'vibes',
        },
        {
          key: 'non-string-kind',
          content: 'Durable fact with a numeric kind.',
          scope: 'agent',
          kind: 7,
        },
      ])
    );

    const result = await extractMemoriesFromCompaction({ threadId: THREAD, agentId: AGENT });

    // All three survive — kind steers recall, it is not a safety gate.
    expect(result.saved).toBe(3);
    expect(result.dropped).toBe(0);
    const keys = (storeMemory.mock.calls as Array<[{ key: string }]>).map(([input]) => input.key);
    expect(keys).toEqual([
      'understanding-no-kind-at-all',
      'understanding-bogus-kind',
      'understanding-non-string-kind',
    ]);
  });

  it('counts a key-refresh as a duplicate without dropping it', async () => {
    generateUtilityText.mockResolvedValue(
      JSON.stringify([
        { key: 'seen-before', content: 'Refreshed fact.', scope: 'agent', kind: 'connection' },
      ])
    );
    storeMemory.mockResolvedValue({
      id: 'memory-existing',
      key: 'connection-seen-before',
      isDuplicate: true,
    });

    const result = await extractMemoriesFromCompaction({ threadId: THREAD, agentId: AGENT });

    expect(result).toEqual({ saved: 1, proposed: 0, duplicates: 1, dropped: 0 });
  });

  it('asks for each memory kind in both the main and the retry prompt', () => {
    for (const instructions of [
      MEMORY_EXTRACTION_INSTRUCTIONS,
      SIMPLE_MEMORY_EXTRACTION_INSTRUCTIONS,
    ]) {
      for (const kind of MEMORY_KINDS) expect(instructions).toContain(kind);
      // The cap the model is asked for matches the cap the parser enforces.
      expect(instructions).toContain(String(MEMORY_EXTRACTION_MAX_CANDIDATES));
      // Both prompts keep the durability filter.
      expect(instructions.toLowerCase()).toContain('months from now');
    }
    // The main prompt keeps the full filter list and the strict-JSON demand.
    expect(MEMORY_EXTRACTION_INSTRUCTIONS).toContain('transient status');
    expect(MEMORY_EXTRACTION_INSTRUCTIONS).toContain('greetings');
    expect(MEMORY_EXTRACTION_INSTRUCTIONS).toContain('speculation');
    expect(MEMORY_EXTRACTION_INSTRUCTIONS).toContain('STRICT JSON');
  });

  it('drops candidates with a missing or unknown scope instead of guessing', async () => {
    generateUtilityText.mockResolvedValue(
      JSON.stringify([
        { key: 'no-scope', content: 'Fact without a scope.' },
        { key: 'weird-scope', content: 'Fact with a bogus scope.', scope: 'global' },
      ])
    );

    const result = await extractMemoriesFromCompaction({ threadId: THREAD, agentId: AGENT });

    expect(result).toEqual(NO_MEMORIES);
    expect(storeMemory).not.toHaveBeenCalled();
  });

  it.each([
    ['no human participant', []],
    [
      'multiple human participants',
      [
        { id: 'tp-1', threadId: THREAD, memberId: 'member-a', kind: 'user', agentId: null },
        { id: 'tp-2', threadId: THREAD, memberId: 'member-b', kind: 'user', agentId: null },
      ],
    ],
  ])('drops member facts when the owner is ambiguous (%s)', async (_label, participants) => {
    listByThread.mockResolvedValue(participants);

    const result = await extractMemoriesFromCompaction({ threadId: THREAD, agentId: AGENT });

    // The agent fact still lands; the member fact is dropped, not misfiled.
    expect(result).toEqual({ saved: 1, proposed: 0, duplicates: 0, dropped: 1 });
    for (const [input] of storeMemory.mock.calls as Array<[{ memberId?: string }]>) {
      expect(input.memberId).toBeUndefined();
    }
  });

  it('resolves empty when no utility model is available, without calling the provider', async () => {
    resolveUtilityModel.mockResolvedValue({ ok: false, reason: 'no-credentials' });

    const result = await extractMemoriesFromCompaction({ threadId: THREAD, agentId: AGENT });

    expect(result).toEqual(NO_MEMORIES);
    expect(generateUtilityText).not.toHaveBeenCalled();
    expect(storeMemory).not.toHaveBeenCalled();
  });

  it('resolves empty when there is no summary yet (nothing was compacted)', async () => {
    getHistoryByThreadAndAgent.mockResolvedValue([]);

    const result = await extractMemoriesFromCompaction({ threadId: THREAD, agentId: AGENT });

    expect(result).toEqual(NO_MEMORIES);
    expect(generateUtilityText).not.toHaveBeenCalled();
  });

  it('contains a provider failure: resolves empty instead of rejecting', async () => {
    generateUtilityText.mockRejectedValue(new Error('provider exploded'));

    await expect(
      extractMemoriesFromCompaction({ threadId: THREAD, agentId: AGENT })
    ).resolves.toEqual(NO_MEMORIES);
  });

  it('contains a DB failure: resolves empty instead of rejecting', async () => {
    getHistoryByThreadAndAgent.mockRejectedValue(new Error('db down'));

    await expect(
      extractMemoriesFromCompaction({ threadId: THREAD, agentId: AGENT })
    ).resolves.toEqual(NO_MEMORIES);
  });

  it('a failing save drops that candidate but keeps saving the rest', async () => {
    generateUtilityText.mockResolvedValue(
      JSON.stringify([
        { key: 'first-fact', content: 'First durable fact.', scope: 'agent' },
        { key: 'second-fact', content: 'Second durable fact.', scope: 'agent' },
      ])
    );
    storeMemory.mockRejectedValueOnce(new Error('constraint violation')).mockResolvedValueOnce({
      id: 'memory-2',
      key: 'understanding-second-fact',
      isDuplicate: false,
    });

    const result = await extractMemoriesFromCompaction({ threadId: THREAD, agentId: AGENT });

    expect(result).toEqual({ saved: 1, proposed: 0, duplicates: 0, dropped: 1 });
    expect(storeMemory).toHaveBeenCalledTimes(2);
  });
});

describe('parseExtractionResponse', () => {
  it('parses a plain JSON array, defaulting an absent kind', () => {
    expect(parseExtractionResponse('[{"key":"a-b","content":"Fact.","scope":"agent"}]')).toEqual([
      { key: 'understanding-a-b', content: 'Fact.', scope: 'agent', kind: 'understanding' },
    ]);
  });

  it('prefixes the key with the kind the model gave', () => {
    expect(
      parseExtractionResponse(
        '[{"key":"venus-owns-triage","content":"Fact.","scope":"agent","kind":"connection"}]'
      )
    ).toEqual([
      {
        key: 'connection-venus-owns-triage',
        content: 'Fact.',
        scope: 'agent',
        kind: 'connection',
      },
    ]);
  });

  it('normalizes a kind that differs only in case or whitespace', () => {
    const parsed = parseExtractionResponse(
      '[{"key":"a-b","content":"Fact.","scope":"agent","kind":"  AGENT "}]'
    );
    expect(parsed).toEqual([{ key: 'agent-a-b', content: 'Fact.', scope: 'agent', kind: 'agent' }]);
  });

  it('strips markdown code fences', () => {
    const fenced = '```json\n[{"key":"a-b","content":"Fact.","scope":"agent"}]\n```';
    expect(parseExtractionResponse(fenced)).toHaveLength(1);
  });

  it('recovers an array wrapped in prose via the bracket slice', () => {
    const wrapped =
      'Here are the facts:\n[{"key":"a-b","content":"Fact.","scope":"member","kind":"user"}]\nHope that helps!';
    expect(parseExtractionResponse(wrapped)).toEqual([
      { key: 'user-a-b', content: 'Fact.', scope: 'member', kind: 'user' },
    ]);
  });

  it('returns [] for non-JSON, non-array JSON, and empty arrays', () => {
    expect(parseExtractionResponse('total garbage')).toEqual([]);
    expect(parseExtractionResponse('{"key":"a","content":"b","scope":"agent"}')).toEqual([]);
    expect(parseExtractionResponse('[]')).toEqual([]);
  });

  it('normalizes keys to kebab-case and drops unusable ones', () => {
    const parsed = parseExtractionResponse(
      JSON.stringify([
        { key: 'Db  Mode_External!', content: 'Fact.', scope: 'agent', kind: 'connection' },
        { key: '!!!', content: 'Unusable key.', scope: 'agent', kind: 'connection' },
        { key: 42, content: 'Non-string key.', scope: 'agent', kind: 'connection' },
      ])
    );
    expect(parsed).toEqual([
      {
        key: 'connection-db-mode-external',
        content: 'Fact.',
        scope: 'agent',
        kind: 'connection',
      },
    ]);
  });

  it('caps the parsed candidates at the hard limit', () => {
    const parsed = parseExtractionResponse(
      JSON.stringify(
        Array.from({ length: 10 }, (_, i) => ({
          key: `k-${i}`,
          content: `Fact ${i}.`,
          scope: 'agent',
          kind: 'agent',
        }))
      )
    );
    expect(parsed).toHaveLength(MEMORY_EXTRACTION_MAX_CANDIDATES);
  });

  it('deduplicates by (scope, key), first occurrence winning', () => {
    const parsed = parseExtractionResponse(
      JSON.stringify([
        { key: 'same-key', content: 'First.', scope: 'agent', kind: 'connection' },
        { key: 'same-key', content: 'Second.', scope: 'agent', kind: 'connection' },
        {
          key: 'same-key',
          content: 'Member-scoped is distinct.',
          scope: 'member',
          kind: 'connection',
        },
      ])
    );
    expect(parsed).toEqual([
      { key: 'connection-same-key', content: 'First.', scope: 'agent', kind: 'connection' },
      {
        key: 'connection-same-key',
        content: 'Member-scoped is distinct.',
        scope: 'member',
        kind: 'connection',
      },
    ]);
  });

  it('gives the same fact the same key across passes, whatever the key casing', () => {
    // Idempotence is what makes the upsert-by-key dedupe work: the same fact
    // re-extracted next compaction must land on the same row.
    const first = parseExtractionResponse(
      '[{"key":"Deploy Needs Manual Migrate","content":"a","scope":"agent","kind":"connection"}]'
    );
    const second = parseExtractionResponse(
      '[{"key":"deploy-needs-manual-migrate","content":"b","scope":"agent","kind":"connection"}]'
    );
    const third = parseExtractionResponse(
      '[{"key":"connection-deploy-needs-manual-migrate","content":"c","scope":"agent","kind":"connection"}]'
    );
    expect(first[0].key).toBe('connection-deploy-needs-manual-migrate');
    expect(second[0].key).toBe(first[0].key);
    expect(third[0].key).toBe(first[0].key);
  });
});

describe('normalizeMemoryKind', () => {
  it('accepts every known kind, case- and whitespace-insensitively', () => {
    for (const kind of MEMORY_KINDS) {
      expect(normalizeMemoryKind(kind)).toBe(kind);
      expect(normalizeMemoryKind(` ${kind.toUpperCase()} `)).toBe(kind);
    }
  });

  it('falls back to the default kind for missing, unknown, or non-string kinds', () => {
    expect(normalizeMemoryKind(undefined)).toBe(DEFAULT_MEMORY_KIND);
    expect(normalizeMemoryKind(null)).toBe(DEFAULT_MEMORY_KIND);
    expect(normalizeMemoryKind('lesson')).toBe(DEFAULT_MEMORY_KIND);
    expect(normalizeMemoryKind(42)).toBe(DEFAULT_MEMORY_KIND);
    expect(normalizeMemoryKind({})).toBe(DEFAULT_MEMORY_KIND);
  });
});

describe('applyKindPrefix', () => {
  it('prefixes an unprefixed key', () => {
    expect(applyKindPrefix('db-mode', 'connection')).toBe('connection-db-mode');
  });

  it('is idempotent: an already-prefixed key is left alone', () => {
    expect(applyKindPrefix('connection-db-mode', 'connection')).toBe('connection-db-mode');
    expect(applyKindPrefix('user-short-reports', 'user')).toBe('user-short-reports');
  });

  it('treats a key equal to the bare kind as already prefixed', () => {
    expect(applyKindPrefix('agent', 'agent')).toBe('agent');
  });

  it('does not strip a different kind name appearing inside the key', () => {
    // 'agent-handoff' under kind 'connection' is a connection about agents.
    expect(applyKindPrefix('agent-handoff', 'connection')).toBe('connection-agent-handoff');
  });

  it('bounds the prefixed key and never leaves a trailing dash', () => {
    const long = applyKindPrefix('x'.repeat(100), 'understanding');
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.startsWith('understanding-')).toBe(true);
    expect(long.endsWith('-')).toBe(false);
  });
});

describe('normalizeMemoryKey', () => {
  it('kebab-cases, trims dashes, and bounds length', () => {
    expect(normalizeMemoryKey('  Deploy Needs   manual_migrate ')).toBe(
      'deploy-needs-manual-migrate'
    );
    expect(normalizeMemoryKey('--already-kebab--')).toBe('already-kebab');
    expect(normalizeMemoryKey('x'.repeat(200))).toHaveLength(80);
  });

  it('returns null for non-strings and strings with nothing usable', () => {
    expect(normalizeMemoryKey(undefined)).toBeNull();
    expect(normalizeMemoryKey(7)).toBeNull();
    expect(normalizeMemoryKey('!!! ???')).toBeNull();
  });
});
