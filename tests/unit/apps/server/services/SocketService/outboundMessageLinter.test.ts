jest.mock('@snaglet/db/db', () => ({
  getPool: jest.fn(),
  getDb: jest.fn(),
}));

import { getDb } from '@snaglet/db/db';
import {
  extractCanonicalWorkspaceReferences,
  extractNodeIdsFromText,
  extractWorkspaceReferencesFromText,
  lintWorkspaceReferencesInMessage,
  lintCanonicalWorkspaceReferencesInContent,
} from '@server/services/SocketService/outboundMessageLinter';

interface NodeRow {
  id: string;
  type: string;
  archived: boolean;
}

function mockNodesQuery(rows: NodeRow[]): jest.Mock {
  const query = jest.fn(async () => ({ rows }));
  (getDb as jest.Mock).mockReturnValue({ query });
  return query;
}

const DOC_ID = 'doc-1111111111111-2djr9lby1';
const OTHER_DOC_ID = 'doc-2222222222222-89cb1mjy7';
const THREAD_ID = 'thread-3333333333333-eu8qs4dyq';
const MISSING_ID = 'doc-9999999999999-fabricated';

describe('workspace reference extraction', () => {
  it('extracts real chip references and bare workspace ids without double-counting chips', () => {
    expect(
      extractWorkspaceReferencesFromText(
        `See [Design](doc:${DOC_ID}), [Discussion](${THREAD_ID}), and ${OTHER_DOC_ID}.`
      ).map(({ id, nodeType, source }) => ({ id, nodeType, source }))
    ).toEqual([
      { id: DOC_ID, nodeType: 'doc', source: 'chip' },
      { id: THREAD_ID, nodeType: 'thread', source: 'chip' },
      { id: OTHER_DOC_ID, nodeType: 'doc', source: 'bare' },
    ]);
  });

  it('keeps the declared chip kind so wrong-kind references can be rejected', () => {
    expect(extractWorkspaceReferencesFromText(`[Wrong](thread:${DOC_ID})`)).toEqual([
      expect.objectContaining({ id: DOC_ID, nodeType: 'thread', source: 'chip' }),
    ]);
  });

  it('ignores malformed and partial id-looking strings', () => {
    expect(
      extractWorkspaceReferencesFromText(
        'doc-123 doc-1111111111111- doc-1111111111111-valid_suffix [x](doc:doc-123)'
      )
    ).toEqual([]);
  });

  it('keeps the existing raw-id extractor behavior for realistic ids', () => {
    expect(extractNodeIdsFromText(`See ${DOC_ID} and ${THREAD_ID}.`)).toEqual([DOC_ID, THREAD_ID]);
  });

  it('limits durable validation to canonical refs outside code and quoted text', () => {
    const text = [
      `Plain pasted id ${MISSING_ID}.`,
      `> Quoted [missing](${MISSING_ID})`,
      '```md',
      `[example](${MISSING_ID})`,
      '```',
      `[real reference](${DOC_ID})`,
    ].join('\n');

    expect(extractCanonicalWorkspaceReferences(text).map((ref) => ref.id)).toEqual([DOC_ID]);
  });
});

describe('lintWorkspaceReferencesInMessage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes a resolvable id through untouched', async () => {
    const query = mockNodesQuery([{ id: DOC_ID, type: 'doc', archived: false }]);
    const content = `Updated [Design](${DOC_ID}).`;

    await expect(lintWorkspaceReferencesInMessage(content)).resolves.toEqual({
      content,
      issues: [],
      infrastructureError: false,
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([[DOC_ID]]);
  });

  it('flags a nonexistent id and removes the dead chip', async () => {
    mockNodesQuery([]);
    const result = await lintWorkspaceReferencesInMessage(`See [Missing](${MISSING_ID}).`);

    expect(result.content).toBe(`See Missing [unverified: ${MISSING_ID} — not found].`);
    expect(result.issues).toEqual([{ id: MISSING_ID, nodeType: 'doc', reason: 'not_found' }]);
  });

  // Existence in public.nodes is the authority, not turn-local provenance: an
  // agent may cite a doc it created in an earlier turn without re-fetching it.
  it('does not flag a real id just because no tool returned it this turn', async () => {
    mockNodesQuery([{ id: DOC_ID, type: 'doc', archived: false }]);
    const content = `See [Design](${DOC_ID}).`;
    const result = await lintWorkspaceReferencesInMessage(content);

    expect(result.content).toBe(content); // rendered untouched
    expect(result.issues).toEqual([]);
  });

  it('flags a wrong-kind chip even though the id resolves', async () => {
    mockNodesQuery([{ id: DOC_ID, type: 'doc', archived: false }]);
    const result = await lintWorkspaceReferencesInMessage(`[Wrong](thread:${DOC_ID})`);

    expect(result.content).toBe(`Wrong [unverified: ${DOC_ID} — expected thread, found doc]`);
    expect(result.issues).toEqual([
      { id: DOC_ID, nodeType: 'thread', reason: 'wrong_kind', actualType: 'doc' },
    ]);
  });

  it('flags an archived id even though it resolves', async () => {
    mockNodesQuery([{ id: DOC_ID, type: 'doc', archived: true }]);
    const result = await lintWorkspaceReferencesInMessage(`[Old plan](${DOC_ID})`);

    expect(result.content).toBe(`Old plan [unverified: ${DOC_ID} — archived]`);
    expect(result.issues).toEqual([{ id: DOC_ID, nodeType: 'doc', reason: 'archived' }]);
  });

  it('batches multiple mixed references and only rewrites offenders', async () => {
    const query = mockNodesQuery([
      { id: DOC_ID, type: 'doc', archived: false },
      { id: THREAD_ID, type: 'thread', archived: false },
    ]);
    const content = `[Design](${DOC_ID}), [Thread](${THREAD_ID}), [Missing](${MISSING_ID}), and ${OTHER_DOC_ID}.`;
    const result = await lintWorkspaceReferencesInMessage(content);

    // Both resolvable references render untouched; only the two ids with
    // no row in public.nodes are rewritten.
    expect(result.content).toBe(
      `[Design](${DOC_ID}), [Thread](${THREAD_ID}), Missing ` +
        `[unverified: ${MISSING_ID} — not found], and ` +
        `[unverified: ${OTHER_DOC_ID} — not found].`
    );
    expect(result.issues).toHaveLength(2);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([[DOC_ID, THREAD_ID, MISSING_ID, OTHER_DOC_ID]]);
  });

  it('does no database work when the message has zero references', async () => {
    const query = mockNodesQuery([]);
    const content = 'Just a normal reply.';
    await expect(lintWorkspaceReferencesInMessage(content)).resolves.toEqual({
      content,
      issues: [],
      infrastructureError: false,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('fails open when the batched lookup has an infrastructure error', async () => {
    const query = jest.fn(async () => {
      throw new Error('database unavailable');
    });
    (getDb as jest.Mock).mockReturnValue({ query });
    const content = `See [Design](${DOC_ID}).`;

    await expect(lintWorkspaceReferencesInMessage(content)).resolves.toEqual({
      content,
      issues: [],
      infrastructureError: true,
    });
  });

  it('does not flag a real node that lives outside the current project scope', async () => {
    // Cross-project and root-level references are legitimate (shared guides,
    // workspace-level docs). The guardrail only fires when an id genuinely
    // does not match the database: missing, archived, or wrong kind.
    mockNodesQuery([{ id: DOC_ID, type: 'doc', archived: false }]);

    const content = `[Elsewhere](${DOC_ID})`;
    await expect(lintWorkspaceReferencesInMessage(content)).resolves.toEqual({
      content,
      issues: [],
      infrastructureError: false,
    });
  });

  it('lets a verified canonical durable reference pass while ignoring plain id-like prose', async () => {
    mockNodesQuery([{ id: DOC_ID, type: 'doc', archived: false }]);
    const content = `Copied ${MISSING_ID}; use [Design](${DOC_ID}).`;

    await expect(lintCanonicalWorkspaceReferencesInContent(content)).resolves.toEqual({
      content,
      issues: [],
      infrastructureError: false,
    });
  });
});

describe('table: chips', () => {
  beforeEach(() => jest.clearAllMocks());

  // Database tables are not nodes, so the linter must neither look them up in
  // public.nodes nor rewrite them as unverified.
  it('leaves builtin and custom table chips unchanged without a nodes lookup', async () => {
    const query = mockNodesQuery([]);
    const content =
      'Rows live in [Docs](table:table-builtin-docs) and [Test Table](table:table-1111111111111-abcdefghi).';

    expect(extractWorkspaceReferencesFromText(content)).toEqual([]);
    await expect(lintWorkspaceReferencesInMessage(content)).resolves.toEqual({
      content,
      issues: [],
      infrastructureError: false,
    });
    await expect(lintCanonicalWorkspaceReferencesInContent(content)).resolves.toEqual({
      content,
      issues: [],
      infrastructureError: false,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('validates node chips beside a table chip and leaves the table chip intact', async () => {
    const query = mockNodesQuery([]);
    const result = await lintWorkspaceReferencesInMessage(
      `[Docs](table:table-builtin-docs) and [Missing](${MISSING_ID})`
    );

    expect(result.content).toBe(
      `[Docs](table:table-builtin-docs) and Missing [unverified: ${MISSING_ID} — not found]`
    );
    expect(query.mock.calls[0]?.[1]).toEqual([[MISSING_ID]]);
  });
});

describe('tool: chips', () => {
  beforeEach(() => jest.clearAllMocks());

  // A tool's id is its name slug; a registered tool has a `public.nodes` row of
  // type 'tool' under the same id, so the one nodes lookup resolves it.
  it('accepts a reference to an existing tool by its slug id', async () => {
    const query = mockNodesQuery([{ id: 'weather_today', type: 'tool', archived: false }]);
    const content = 'Ask [Weather today](tool:weather_today) first.';

    await expect(lintCanonicalWorkspaceReferencesInContent(content)).resolves.toEqual({
      content,
      issues: [],
      infrastructureError: false,
    });
    expect(query.mock.calls[0]?.[1]).toEqual([['weather_today']]);
  });

  it('rejects a reference to a tool slug that does not exist', async () => {
    mockNodesQuery([]);
    const result = await lintCanonicalWorkspaceReferencesInContent('Ask [Weather](tool:weather).');

    expect(result.issues).toEqual([{ id: 'weather', nodeType: 'tool', reason: 'not_found' }]);
  });

  it('does not read a body outside the tool id grammar as a tool reference', () => {
    expect(
      extractCanonicalWorkspaceReferences('[A](tool:weather today) [B](tool:weather!) [C](tool:)')
    ).toEqual([]);
  });
});
