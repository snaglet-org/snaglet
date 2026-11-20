import { describe, expect, it } from '@jest/globals';
import {
  appendDigestSection,
  DIGEST_MAX_CHARS,
  DIGEST_OMITTED_MARKER,
} from '@server/services/summary/digestSections';

describe('appendDigestSection', () => {
  it('starts a digest with its first section', () => {
    expect(appendDigestSection(null, 'First.')).toBe('First.');
    expect(appendDigestSection('', 'First.')).toBe('First.');
  });

  it('keeps the earlier text verbatim and adds the new section after a blank line', () => {
    expect(appendDigestSection('One.\n\nTwo.', 'Three.')).toBe('One.\n\nTwo.\n\nThree.');
  });

  it('past the cap, drops the oldest sections whole and says so', () => {
    const section = (n: number) => `Section ${n}: ${'x'.repeat(DIGEST_MAX_CHARS / 4)}`;
    let digest: string | null = null;
    for (let n = 1; n <= 6; n++) digest = appendDigestSection(digest, section(n));
    expect(digest!.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS + DIGEST_OMITTED_MARKER.length + 2);
    expect(digest!.startsWith(DIGEST_OMITTED_MARKER)).toBe(true);
    expect(digest).not.toContain('Section 1:');
    expect(digest).toContain('Section 6:');
  });

  it('never drops the section just written, however long it is', () => {
    const huge = 'y'.repeat(DIGEST_MAX_CHARS * 2);
    const out = appendDigestSection('Old.', huge);
    expect(out).toContain(huge);
    expect(out).not.toContain('Old.');
  });

  it('does not stack the omitted marker', () => {
    const big = (n: number) => `S${n} ${'z'.repeat(DIGEST_MAX_CHARS / 3)}`;
    let digest: string | null = null;
    for (let n = 1; n <= 12; n++) digest = appendDigestSection(digest, big(n));
    expect(digest!.split(DIGEST_OMITTED_MARKER).length - 1).toBe(1);
  });
});
