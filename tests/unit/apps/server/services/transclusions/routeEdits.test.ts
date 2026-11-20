import { describe, expect, it } from '@jest/globals';
import { routeEdits, type EditChange } from '@server/services/transclusions/routeEdits';
import type { TranscludableDoc } from '@server/services/transclusions/expandTransclusions';

function world(docs: Record<string, string>, archived: string[] = []) {
  const byId = new Map<string, TranscludableDoc>(
    Object.entries(docs).map(([id, content]) => [
      id,
      { id, title: id.toUpperCase(), content, archived: archived.includes(id) },
    ])
  );
  let loads = 0;
  const load = async (ids: string[]) => {
    loads += 1;
    return new Map(ids.filter((id) => byId.has(id)).map((id) => [id, byId.get(id)!]));
  };
  return { load, loads: () => loads };
}

async function route(
  docs: Record<string, string>,
  rootId: string,
  edits: EditChange[],
  raw = false
) {
  const w = world(docs);
  const out = await routeEdits({
    root: { id: rootId, title: rootId.toUpperCase(), content: docs[rootId]! },
    edits,
    load: w.load,
    raw,
  });
  return { ...out, after: (id: string) => out.changed.get(id) ?? docs[id] };
}

// "foo" reads four times: A, B (first copy), B (second copy), A.
const TWICE = {
  'doc-a': 'foo one\n![B](doc-b)\nmiddle\n![B](doc-b)\nfoo two',
  'doc-b': 'foo in b',
};

describe('routeEdits: occurrence counts what the agent reads', () => {
  it('numbers matches in reading order, copies of one doc included', async () => {
    const third = await route(TWICE, 'doc-a', [
      { old_text: 'foo', new_text: 'FOO', occurrence: 3 },
    ]);
    expect(third.applied).toEqual([
      expect.objectContaining({ doc_id: 'doc-b', applied_at: 0, occurrences_found: 4 }),
    ]);
    expect(third.after('doc-b')).toBe('FOO in b');
    expect(third.after('doc-a')).toBe(TWICE['doc-a']);

    const fourth = await route(TWICE, 'doc-a', [
      { old_text: 'foo', new_text: 'FOO', occurrence: 4 },
    ]);
    expect(fourth.after('doc-a')).toBe('foo one\n![B](doc-b)\nmiddle\n![B](doc-b)\nFOO two');
    expect(fourth.changed.has('doc-b')).toBe(false);
  });

  it('calls a match ambiguous by place, numbering the previews in reading order', async () => {
    await expect(route(TWICE, 'doc-a', [{ old_text: 'foo', new_text: 'FOO' }])).rejects.toThrow(
      /ambiguous \(4 matches, 3 places\)[\s\S]*occurrence 1 in "DOC-A"[\s\S]*occurrence 2 in "DOC-B"[\s\S]*occurrence 3 in "DOC-B" \(doc-b\), the same text as occurrence 2[\s\S]*occurrence 4 in "DOC-A"/
    );
  });

  it('treats a doc shown twice as one place', async () => {
    const out = await route(TWICE, 'doc-a', [{ old_text: 'in b', new_text: 'IN B' }]);
    expect(out.after('doc-b')).toBe('foo IN B');
  });

  it('says how many it read when occurrence is out of range', async () => {
    await expect(
      route(TWICE, 'doc-a', [{ old_text: 'foo', new_text: 'FOO', occurrence: 5 }])
    ).rejects.toThrow('occurrence 5 out of range (found 4)');
  });

  it('occurrence -1 changes every place once, each in the doc that owns it', async () => {
    const out = await route(TWICE, 'doc-a', [{ old_text: 'foo', new_text: 'FOO', occurrence: -1 }]);
    expect(out.after('doc-a')).toBe('FOO one\n![B](doc-b)\nmiddle\n![B](doc-b)\nFOO two');
    expect(out.after('doc-b')).toBe('FOO in b');
    expect(out.applied.map((a) => a.doc_id).sort()).toEqual(['doc-a', 'doc-a', 'doc-b']);
  });

  it('occurrence -1 refuses when one of the matches touches a tag', async () => {
    await expect(
      route({ 'doc-a': 'title DOC-B\n![B](doc-b)', 'doc-b': 'body' }, 'doc-a', [
        { old_text: 'DOC-B', new_text: 'x', occurrence: -1 },
      ])
    ).rejects.toThrow('<transcluded-doc> tag');
  });

  it('occurrence -1 in the stored source changes every match there', async () => {
    const out = await route(
      { 'doc-a': 'a a ![x](doc-b) a', 'doc-b': 'b' },
      'doc-a',
      [{ old_text: 'a', new_text: 'z', occurrence: -1 }],
      true
    );
    expect(out.after('doc-a')).toBe('z z ![x](doc-b) z');
  });
});

describe('routeEdits: one expansion per batch', () => {
  const SHARED = { 'doc-a': 'root\n![B](doc-b)\n![B](doc-b)\nend', 'doc-b': 'alpha beta gamma' };

  it('reads the docs once for many text edits, patching every copy', async () => {
    const w = world(SHARED);
    const out = await routeEdits({
      root: { id: 'doc-a', title: 'A', content: SHARED['doc-a'] },
      edits: [
        { old_text: 'alpha', new_text: 'ALPHA ALPHA', occurrence: 1 },
        { old_text: 'ALPHA ALPHA beta', new_text: 'one', occurrence: 2 },
        { old_text: 'gamma', new_text: 'G', occurrence: 1 },
        { old_text: 'end', new_text: 'END' },
      ],
      load: w.load,
      raw: false,
    });
    expect(w.loads()).toBe(1);
    expect(out.changed.get('doc-b')).toBe('one G');
    expect(out.changed.get('doc-a')).toBe('root\n![B](doc-b)\n![B](doc-b)\nEND');
  });

  it('expands again when an edit adds a transclusion, so later edits see it', async () => {
    const out = await route(
      { 'doc-a': 'A ![B](doc-b) ![C](doc-c)', 'doc-b': 'bbb', 'doc-c': 'ccc' },
      'doc-a',
      [
        { old_text: 'bbb', new_text: 'bbb ![C](doc-c)' },
        { old_text: 'ccc', new_text: 'CCC', occurrence: -1 },
      ]
    );
    expect(out.after('doc-b')).toBe('bbb ![C](doc-c)');
    expect(out.after('doc-c')).toBe('CCC');
  });
});

describe('routeEdits: text inside a transclusion line', () => {
  const LABEL = { 'doc-a': 'See:\n![Budget](doc-b)', 'doc-b': 'Budget 2026: 10k' };

  it('counts a label match as a candidate, so the edit is ambiguous with a raw hint', async () => {
    await expect(
      route(LABEL, 'doc-a', [{ old_text: 'Budget', new_text: 'Spend' }])
    ).rejects.toThrow(
      /ambiguous \(2 matches\)[\s\S]*occurrence 1 in "DOC-B"[\s\S]*occurrence 2 in the stored source of "DOC-A" \(doc-a\), inside a transclusion line[\s\S]*pass raw: true/
    );
  });

  it('numbers it after what a read shows, and edits the line when picked', async () => {
    const shown = await route(LABEL, 'doc-a', [
      { old_text: 'Budget', new_text: 'Spend', occurrence: 1 },
    ]);
    expect(shown.after('doc-b')).toBe('Spend 2026: 10k');
    const line = await route(LABEL, 'doc-a', [
      { old_text: 'Budget', new_text: 'Spend', occurrence: 2 },
    ]);
    expect(line.after('doc-a')).toBe('See:\n![Spend](doc-b)');
    expect(line.changed.has('doc-b')).toBe(false);
  });

  it('leaves the line alone for occurrence -1, which changes what a read shows', async () => {
    const all = await route(LABEL, 'doc-a', [
      { old_text: 'Budget', new_text: 'Spend', occurrence: -1 },
    ]);
    expect(all.after('doc-b')).toBe('Spend 2026: 10k');
    expect(all.changed.has('doc-a')).toBe(false);
  });
});

describe('routeEdits: a label match only counts against another doc', () => {
  it('edits the heading when the label is the only other match', async () => {
    const out = await route(
      { 'doc-a': '## Setup guide\n![Setup guide](doc-b)', 'doc-b': 'steps' },
      'doc-a',
      [{ old_text: 'Setup guide', new_text: 'Install guide' }]
    );
    expect(out.after('doc-a')).toBe('## Install guide\n![Setup guide](doc-b)');
  });
});
