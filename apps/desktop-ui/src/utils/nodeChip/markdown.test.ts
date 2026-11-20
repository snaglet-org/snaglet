import { describe, expect, it } from 'vitest';
import { escapeChipTitle, toggleChipIncludeInMarkdown, unescapeChipTitle } from './markdown';

describe('chip title escaping', () => {
  it.each(['Plain', '[Draft] Memo', 'a \\ b', 'nested [[x]] \\]'])(
    'round-trips %j through the [label] syntax',
    (title) => {
      expect(unescapeChipTitle(escapeChipTitle(title))).toBe(title);
    }
  );

  it('flattens line breaks, which a single-line label cannot hold', () => {
    expect(unescapeChipTitle(escapeChipTitle('First\nSecond\r\nThird'))).toBe('First Second Third');
  });
});

describe('toggleChipIncludeInMarkdown with escaped titles', () => {
  const href = 'doc-1111111111111-aaaaaaaaa';

  it('toggles a chip whose title has escaped brackets, both ways', () => {
    const link = `See [Budget \\[2026\\]](${href}) here`;
    const transcluded = toggleChipIncludeInMarkdown(link, href);
    expect(transcluded).toBe(`See ![](${href}) here`);
    expect(
      toggleChipIncludeInMarkdown(`![Budget \\[2026\\]](${href})`, href, 'Budget [2027]')
    ).toBe(`[Budget \\[2027\\]](${href})`);
  });
});
