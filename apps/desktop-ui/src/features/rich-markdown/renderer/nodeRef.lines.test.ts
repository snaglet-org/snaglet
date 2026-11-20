import { describe, expect, it } from 'vitest';
import { NODE_HREF_SOURCE, parseNodeRef } from './nodeRef';

const ID = 'doc-1111111111111-aaaaaaaaa';

describe('doc line-link chips', () => {
  it('parses `doc-…#L12-L20` as the doc plus its lines', () => {
    expect(parseNodeRef(`${ID}#L12-L20`)).toEqual({
      kind: 'doc',
      id: ID,
      anchor: { lines: { startLine: 12, endLine: 20 } },
    });
    expect(parseNodeRef(`${ID}#L3:2-L4:9`)?.anchor).toEqual({
      lines: { startLine: 3, endLine: 4, startChar: 2, endChar: 9 },
    });
  });

  it('parses heading links, with and without a level', () => {
    expect(parseNodeRef(`${ID}#h=rate-limits`)?.anchor).toEqual({
      heading: { slug: 'rate-limits' },
    });
    expect(parseNodeRef(`${ID}#h3=rate-limits-1`)?.anchor).toEqual({
      heading: { slug: 'rate-limits-1', level: 3 },
    });
    const m = new RegExp(NODE_HREF_SOURCE).exec(`see ${ID}#h3=rate-limits here`);
    expect(m?.[0]).toBe(`${ID}#h3=rate-limits`);
    expect(parseNodeRef(`${ID}#h=part-1..h=part-3`)?.anchor).toEqual({
      heading: { slug: 'part-1', to: { slug: 'part-3' } },
    });
    const r = new RegExp(NODE_HREF_SOURCE).exec(`x ${ID}#h=part-1..h2=part-3) y`);
    expect(r?.[0]).toBe(`${ID}#h=part-1..h2=part-3`);
  });

  it('keeps plain doc chips unchanged and rejects bad or non-doc fragments', () => {
    expect(parseNodeRef(ID)).toEqual({ kind: 'doc', id: ID });
    expect(parseNodeRef(`${ID}#intro`)).toBeNull();
    expect(parseNodeRef('thread-1111111111111-aaaaaaaaa#L3')).toBeNull();
  });

  it('bare-id grammar picks up the whole line link', () => {
    const m = new RegExp(NODE_HREF_SOURCE).exec(`see ${ID}#L12-L20 here`);
    expect(m?.[0]).toBe(`${ID}#L12-L20`);
  });
});
