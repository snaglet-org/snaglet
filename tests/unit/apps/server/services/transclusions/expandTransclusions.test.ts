import { describe, expect, it } from '@jest/globals';
import {
  expandTransclusions,
  MAX_EXPANDED_CHARS,
  type Expansion,
  type TranscludableDoc,
} from '@server/services/transclusions/expandTransclusions';

function store(docs: Array<Partial<TranscludableDoc> & { id: string }>) {
  const byId = new Map(
    docs.map((d) => [
      d.id,
      { title: d.id.toUpperCase(), content: '', archived: false, ...d } as TranscludableDoc,
    ])
  );
  const load = async (ids: string[]) =>
    new Map(ids.filter((id) => byId.has(id)).map((id) => [id, byId.get(id)!]));
  return { byId, load };
}

/** Every text segment must be its owner's stored text at the recorded offset. */
function expectSegmentsMapBack(expansion: Expansion, byId: Map<string, TranscludableDoc>) {
  for (const seg of expansion.segments) {
    if (seg.kind !== 'text') continue;
    const piece = expansion.text.slice(seg.start, seg.end);
    const owner = byId.get(seg.docId)!;
    expect(owner.content.slice(seg.sourceStart, seg.sourceStart + piece.length)).toBe(piece);
  }
}

describe('expandTransclusions', () => {
  it('replaces a transclusion in place, wrapped with id and title', async () => {
    const { byId, load } = store([
      { id: 'doc-a', content: 'Intro\n![B](doc-b)\nOutro' },
      { id: 'doc-b', title: 'Bee', content: 'Bee body' },
    ]);
    const out = await expandTransclusions(
      { id: 'doc-a', content: byId.get('doc-a')!.content },
      load
    );
    expect(out.text).toBe(
      'Intro\n<transcluded-doc id="doc-b" title="Bee">\nBee body\n</transcluded-doc>\nOutro'
    );
    expect(out.segments.map((s) => [s.kind, s.docId])).toEqual([
      ['text', 'doc-a'],
      ['wrapper', 'doc-a'],
      ['text', 'doc-b'],
      ['wrapper', 'doc-a'],
      ['text', 'doc-a'],
    ]);
    expectSegmentsMapBack(out, byId);
  });

  it('expands nested transclusions three levels deep, then leaves a marker', async () => {
    const { byId, load } = store([
      { id: 'doc-a', content: '![](doc-b)' },
      { id: 'doc-b', content: 'b ![](doc-c)' },
      { id: 'doc-c', content: 'c ![](doc-d)' },
      { id: 'doc-d', content: 'd ![](doc-e)' },
      { id: 'doc-e', content: 'e' },
    ]);
    const out = await expandTransclusions({ id: 'doc-a', content: '![](doc-b)' }, load);
    expect(out.text).toContain('<transcluded-doc id="doc-d" title="DOC-D">\nd ');
    expect(out.text).toContain('<transcluded-doc id="doc-e" title="DOC-E" skipped="depth"/>');
    expect(out.text).not.toContain('\ne\n');
    expectSegmentsMapBack(out, byId);
  });

  it('marks missing and archived targets without content or comments', async () => {
    const { load } = store([{ id: 'doc-gone', title: 'Gone', content: 'secret', archived: true }]);
    const out = await expandTransclusions(
      { id: 'doc-a', content: '![](doc-nowhere)\n![](doc-gone)' },
      load
    );
    expect(out.text).toBe(
      '<transcluded-doc id="doc-nowhere" missing="true"/>\n' +
        '<transcluded-doc id="doc-gone" title="Gone" archived="true"/>'
    );
    expect(out.text).not.toContain('<!--');
  });

  it('never expands a loop already in stored data', async () => {
    const { byId, load } = store([
      { id: 'doc-a', content: 'a ![](doc-b) ![](doc-a)' },
      { id: 'doc-b', content: 'b ![](doc-a)' },
    ]);
    const out = await expandTransclusions(
      { id: 'doc-a', content: byId.get('doc-a')!.content },
      load
    );
    expect(out.text).toBe(
      'a <transcluded-doc id="doc-b" title="DOC-B">\n' +
        'b <transcluded-doc id="doc-a" title="DOC-A" skipped="loop"/>' +
        '\n</transcluded-doc> <transcluded-doc id="doc-a" title="DOC-A" skipped="loop"/>'
    );
  });

  it('escapes titles so they cannot break out of the attribute or fake a tag', async () => {
    const { load } = store([
      { id: 'doc-b', title: 'x" evil="1"></transcluded-doc><b & c', content: 'body' },
    ]);
    const out = await expandTransclusions({ id: 'doc-a', content: '![](doc-b)' }, load);
    expect(out.text.split('\n')[0]).toBe(
      '<transcluded-doc id="doc-b" title="x&quot; evil=&quot;1&quot;&gt;&lt;/transcluded-doc&gt;&lt;b &amp; c">'
    );
  });

  it('keeps a literal closing tag inside a transcluded doc as that doc’s text', async () => {
    const { byId, load } = store([
      { id: 'doc-a', content: '![](doc-b)\nafter' },
      { id: 'doc-b', content: 'one\n</transcluded-doc>\ntwo' },
    ]);
    const out = await expandTransclusions(
      { id: 'doc-a', content: byId.get('doc-a')!.content },
      load
    );
    const at = out.text.indexOf('</transcluded-doc>');
    const owner = out.segments.find((s) => s.start <= at && at < s.end)!;
    expect(owner).toMatchObject({ kind: 'text', docId: 'doc-b' });
    expectSegmentsMapBack(out, byId);
  });

  it('shows only the linked part of a doc and maps it to the right offsets', async () => {
    const { byId, load } = store([
      { id: 'doc-a', content: 'see ![](doc-b#h=setup) end' },
      { id: 'doc-b', title: 'Guide', content: '# Guide\n\n## Setup\nrun it\n\n## Other\nx' },
    ]);
    const out = await expandTransclusions(
      { id: 'doc-a', content: byId.get('doc-a')!.content },
      load
    );
    expect(out.text).toBe(
      'see <transcluded-doc id="doc-b" title="Guide" part="h=setup">\n## Setup\nrun it\n</transcluded-doc> end'
    );
    expectSegmentsMapBack(out, byId);
  });

  it('marks a part that no longer exists', async () => {
    const { load } = store([{ id: 'doc-b', title: 'Guide', content: '# Guide' }]);
    const out = await expandTransclusions({ id: 'doc-a', content: '![](doc-b#h=gone)' }, load);
    expect(out.text).toBe(
      '<transcluded-doc id="doc-b" title="Guide" part="h=gone" missing="part"/>'
    );
  });
});

describe('expandTransclusions: size budget', () => {
  it('stops a fan-out at the budget with size markers', async () => {
    const line = (id: string) => `![x](${id})\n`;
    const { load } = store([
      { id: 'doc-a', content: line('doc-b').repeat(40) },
      { id: 'doc-b', content: line('doc-c').repeat(40) },
      { id: 'doc-c', content: line('doc-d').repeat(40) },
      { id: 'doc-d', content: 'x'.repeat(4096) },
    ]);
    const out = await expandTransclusions({ id: 'doc-a', content: line('doc-b').repeat(40) }, load);
    expect(out.text.length).toBeLessThanOrEqual(MAX_EXPANDED_CHARS + 20_000);
    expect(out.text.length).toBeGreaterThan(MAX_EXPANDED_CHARS / 2);
    expect(out.text).toContain('skipped="size"/>');
  });

  it('never cuts the doc itself, and marks what would not fit', async () => {
    const { load } = store([{ id: 'doc-b', title: 'Big', content: 'b'.repeat(500) }]);
    const own = 'x'.repeat(300);
    const out = await expandTransclusions(
      { id: 'doc-a', content: `${own}\n![](doc-b)\n${own}` },
      load,
      { maxChars: 1000 }
    );
    expect(out.text).toBe(
      `${own}\n<transcluded-doc id="doc-b" title="Big" skipped="size"/>\n${own}`
    );
    expect(out.segments.find((s) => s.kind === 'wrapper')).toMatchObject({
      role: 'marker',
      reason: 'size',
    });
  });
});

describe('expandTransclusions: parts and code', () => {
  it('does not expand transclusion syntax that sits in code opened before the part', async () => {
    const { byId, load } = store([
      { id: 'doc-b', title: 'Notes', content: '```md\n![x](doc-c)\nexample\n```' },
      { id: 'doc-c', title: 'C', content: 'secret' },
    ]);
    const out = await expandTransclusions({ id: 'doc-a', content: '![](doc-b#L2-L3)' }, load);
    expect(out.text).toBe(
      '<transcluded-doc id="doc-b" title="Notes" part="L2-L3">\n![x](doc-c)\nexample\n</transcluded-doc>'
    );
    expect(out.text).not.toContain('secret');
    byId.set('doc-a', { id: 'doc-a', title: 'A', content: '![](doc-b#L2-L3)', archived: false });
    expectSegmentsMapBack(out, byId);
  });

  it('reads labels with escaped and nested brackets, as the editor writes them', async () => {
    const { load } = store([{ id: 'doc-b', title: 'Budget', content: 'b' }]);
    const out = await expandTransclusions(
      { id: 'doc-a', content: '![Budget \\[2026\\]](doc-b) and ![a [b] c](doc-b)' },
      load
    );
    expect(out.text.match(/<transcluded-doc /g)).toHaveLength(2);
  });
});

describe('expandTransclusions: size markers count against the budget', () => {
  const leaf = { id: 'doc-d', title: 'D', content: 'x'.repeat(1024) };

  it('collapses a run of size markers into one that says how many', async () => {
    const lines = '![x](doc-d)\n'.repeat(2000);
    const { load } = store([leaf]);
    const out = await expandTransclusions({ id: 'doc-a', content: lines }, load, {
      maxChars: 30_000,
    });
    expect(out.text.length).toBeLessThanOrEqual(30_000 + 100);
    expect(out.text).toMatch(/<transcluded-doc skipped="size" count="\d+"\/>/);
    // 2000 skipped lines, a few runs between the expansions that still fit.
    expect(out.text.match(/skipped="size"/g)!.length).toBeLessThan(50);
  });

  it('keeps a transcluded doc full of transclusion lines inside the budget', async () => {
    const { load } = store([
      leaf,
      { id: 'doc-b', title: 'B', content: '![x](doc-d)\n'.repeat(3000) },
    ]);
    const out = await expandTransclusions({ id: 'doc-a', content: '![](doc-b)' }, load, {
      maxChars: 50_000,
    });
    expect(out.text.length).toBeLessThanOrEqual(50_000 + 200);
  });

  it('keeps the plain line, not a longer marker, once even markers do not fit', async () => {
    const body = 'item ![x](doc-d)\n'.repeat(3000);
    const { load } = store([leaf, { id: 'doc-b', title: 'B', content: body }]);
    const out = await expandTransclusions({ id: 'doc-a', content: '![](doc-b)' }, load, {
      maxChars: 60_000,
    });
    expect(out.text.length).toBeLessThanOrEqual(60_000 + 200);
    expect(out.text).toContain('item ![x](doc-d)\nitem ![x](doc-d)');
  });
});
