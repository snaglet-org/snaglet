import { chunkContent, contentBudgetChars } from '@server/services/embedding/chunkContent';

describe('contentBudgetChars', () => {
  it('converts tokens to chars with safety margin', () => {
    // 2048 tokens × 4 chars × 0.85 = 6963
    expect(contentBudgetChars(2048)).toBe(6963);
  });

  it('never returns a degenerate budget', () => {
    expect(contentBudgetChars(1)).toBeGreaterThanOrEqual(200);
  });
});

describe('chunkContent', () => {
  it('returns a single chunk when content fits', () => {
    const chunks = chunkContent('hello world', { maxChars: 1000 });
    expect(chunks).toEqual([{ text: 'hello world', index: 0, start: 0, end: 11 }]);
  });

  it('splits oversized content into multiple chunks within budget', () => {
    const content = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} ends here.`).join(
      ' '
    );
    const chunks = chunkContent(content, { maxChars: 1000 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(1000);
    }
  });

  it('core spans tile the source exactly (no gaps, no overlap in offsets)', () => {
    const content = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkContent(content, { maxChars: 500 });
    expect(chunks[0].start).toBe(0);
    expect(chunks[chunks.length - 1].end).toBe(content.length);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].start).toBe(chunks[i - 1].end);
    }
    // Reassembling the cores reproduces the source.
    const reassembled = chunks.map((c) => content.slice(c.start, c.end)).join('');
    expect(reassembled).toBe(content);
  });

  it('produces balanced chunks rather than a tiny runt tail', () => {
    // 2.05 budgets of content — greedy splitting would leave a ~5% runt.
    const content = 'a'
      .repeat(1000)
      .replace(/(.{50})/g, '$1 ')
      .repeat(2)
      .slice(0, 2050);
    const chunks = chunkContent(content, { maxChars: 1000, overlapChars: 0 });
    const sizes = chunks.map((c) => c.end - c.start);
    const min = Math.min(...sizes);
    const max = Math.max(...sizes);
    // Balanced: no chunk smaller than half the largest.
    expect(min).toBeGreaterThanOrEqual(Math.floor(max / 2));
  });

  it('prefers paragraph boundaries over mid-sentence cuts', () => {
    const para = `${'alpha beta gamma delta. '.repeat(20)}`.trim();
    const content = `${para}\n\n${para}\n\n${para}`;
    const chunks = chunkContent(content, { maxChars: Math.ceil(content.length / 2) + 50 });
    expect(chunks.length).toBeGreaterThan(1);
    // Every non-final core ends at a structural boundary (whitespace edge).
    for (const c of chunks.slice(0, -1)) {
      const lastChar = content[c.end - 1];
      const nextChar = content[c.end];
      expect(/\s/.test(lastChar) || /\s/.test(nextChar)).toBe(true);
    }
  });

  it('keeps markdown headings with their section', () => {
    const section = (n: number) => `## Heading ${n}\n\n${'body text here. '.repeat(30).trim()}`;
    const content = [section(1), section(2), section(3)].join('\n\n');
    const budget = Math.ceil(content.length / 2);
    const chunks = chunkContent(content, { maxChars: budget, overlapChars: 0 });
    for (const c of chunks.slice(1)) {
      const core = content.slice(c.start, c.end);
      // If a chunk contains a heading, the heading should not be the dangling
      // last line of the previous chunk — i.e. no core ends right after a
      // heading line with no body following it.
      const prev = content.slice(chunks[c.index - 1].start, chunks[c.index - 1].end);
      expect(/\n#{1,6}\s[^\n]*$/.test(prev.trimEnd())).toBe(false);
      expect(core.length).toBeGreaterThan(0);
    }
  });

  it('adds word-aligned overlap from the previous chunk', () => {
    const content = Array.from({ length: 400 }, (_, i) => `tok${i}`).join(' ');
    const chunks = chunkContent(content, { maxChars: 600, overlapChars: 60 });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      const core = content.slice(chunks[i].start, chunks[i].end);
      // text = overlap + '\n' + core
      expect(chunks[i].text.endsWith(core)).toBe(true);
      expect(chunks[i].text.length).toBeGreaterThan(core.length);
      const prefix = chunks[i].text.slice(0, chunks[i].text.length - core.length - 1);
      // The prefix is a verbatim word-aligned tail of the preceding source.
      expect(content.slice(0, chunks[i].start).trimEnd().endsWith(prefix)).toBe(true);
      expect(prefix.startsWith(' ')).toBe(false);
    }
  });

  it('handles content with no boundaries at all (hard cut)', () => {
    const content = 'x'.repeat(2500);
    const chunks = chunkContent(content, { maxChars: 1000, overlapChars: 0 });
    expect(chunks.length).toBe(3);
    expect(chunks.map((c) => content.slice(c.start, c.end)).join('')).toBe(content);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(1000);
  });

  it('respects maxChars including the overlap prefix', () => {
    const content = Array.from({ length: 1000 }, (_, i) => `w${i}`).join(' ');
    const maxChars = 800;
    const chunks = chunkContent(content, { maxChars });
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(maxChars);
    }
  });
});
