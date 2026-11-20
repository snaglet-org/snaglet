/**
 * safeFilename — the only sanitizer between caller-supplied text and a write.
 *
 * The property that matters is not "produces a nice name", it is "produces
 * exactly one path segment, always". Everything else is cosmetics.
 */

import path from 'path';
import {
  dedupeFilename,
  FALLBACK_STEM,
  MAX_COMPONENT_BYTES,
  safeFilename,
  safeFilenameWithExtension,
} from '@server/services/ExportService/safeFilename';

/** Control characters are built from code points so the test states exactly
 *  which bytes it means, rather than relying on escapes surviving an edit. */
const NUL = String.fromCharCode(0);
const BELL = String.fromCharCode(7);
const DEL = String.fromCharCode(127);

describe('safeFilename', () => {
  it('collapses anything to a single path segment', () => {
    const hostile = [
      '../../../etc/passwd',
      '..\\..\\windows\\system32',
      '/absolute/path',
      'a/b/c',
      'nested\\name',
      '....//....//x',
      '.',
      '..',
      '~/.snaglet/tools',
      `payload${NUL}.md`,
    ];
    for (const input of hostile) {
      const result = safeFilename(input);
      expect(result).toBe(path.basename(result));
      expect(result).not.toContain('/');
      expect(result).not.toContain('\\');
      expect(result.startsWith('.')).toBe(false);
      expect(result.trim()).toBe(result);
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it('never returns an empty string', () => {
    for (const input of ['', '   ', '///', '...', ' ', '\t\n']) {
      expect(safeFilename(input)).toBe(FALLBACK_STEM);
    }
  });

  it('strips control characters, including NUL', () => {
    const result = safeFilename(`re${NUL}port${BELL}name${DEL}`);
    expect(result).toBe('re port name');
    for (const ch of result) {
      const code = ch.codePointAt(0) ?? 0;
      expect(code >= 0x20 && code !== 0x7f).toBe(true);
    }
  });

  it('keeps ordinary punctuation that is legal in filenames', () => {
    // Stripping hyphens would mangle most real titles.
    expect(safeFilename('Q3 plan - draft_v2 (final).notes')).toBe(
      'Q3 plan - draft_v2 (final).notes'
    );
  });

  it('preserves non-ASCII titles', () => {
    expect(safeFilename('Café résumé 日本語')).toBe('Café résumé 日本語');
  });

  it('clamps long names without leaving trailing padding', () => {
    const result = safeFilename('x'.repeat(400));
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result).toBe(result.trim());
  });

  it('defuses Windows reserved device names', () => {
    expect(safeFilename('CON')).toBe('CON_');
    expect(safeFilename('lpt1')).toBe('lpt1_');
    // Not reserved — must not be mangled.
    expect(safeFilename('console')).toBe('console');
  });

  it('drops trailing dots and spaces that the shell would silently strip', () => {
    expect(safeFilename('report.')).toBe('report');
    expect(safeFilename('report ')).toBe('report');
  });
});

describe('safeFilenameWithExtension', () => {
  it('applies the extension after sanitizing, so it cannot be smuggled off', () => {
    expect(safeFilenameWithExtension(`evil${NUL}sh`, '.md')).toBe('evil sh.md');
  });

  it('replaces the extension the user typed rather than appending to it', () => {
    // The stored MIME type is authoritative. Appending would preserve a lie
    // about the format ("my shot.txt.png" still reads as a text file).
    expect(safeFilenameWithExtension('my shot.txt', '.png')).toBe('my shot.png');
    expect(safeFilenameWithExtension('report.doc', '.md')).toBe('report.md');
  });

  it('does not double an extension the user already got right', () => {
    expect(safeFilenameWithExtension('notes.md', '.md')).toBe('notes.md');
    expect(safeFilenameWithExtension('notes.MD', 'md')).toBe('notes.md');
  });

  it('preserves internal dots that are not a trailing extension', () => {
    // "v1.2 shot" must keep its version — ".2 shot" is not an extension.
    expect(safeFilenameWithExtension('v1.2 shot', '.png')).toBe('v1.2 shot.png');
    expect(safeFilenameWithExtension('2026.01.14 notes', '.md')).toBe('2026.01.14 notes.md');
  });

  it('leaves a numeric trailing segment alone — a year is not an extension', () => {
    expect(safeFilenameWithExtension('report.2026', '.md')).toBe('report.2026.md');
  });

  it('replaces alphanumeric extensions that really are extensions', () => {
    expect(safeFilenameWithExtension('track.mp3', '.md')).toBe('track.md');
    expect(safeFilenameWithExtension('bundle.7z', '.md')).toBe('bundle.md');
  });

  it('still yields a usable name when the stem sanitizes away', () => {
    expect(safeFilenameWithExtension('///', '.md')).toBe(`${FALLBACK_STEM}.md`);
  });
});

describe('byte-safe length limits', () => {
  const bytesOf = (s: string) => Buffer.byteLength(s, 'utf8');

  it('bounds the composed name to the component ceiling, with dedupe headroom', () => {
    for (const [input, ext] of [
      ['x'.repeat(1000), '.md'],
      ['é'.repeat(1000), '.md'],
      ['😀'.repeat(1000), '.md'],
      ['日'.repeat(1000), '.jpeg'],
      ['ok', '.superlongextension'],
    ] as const) {
      const name = safeFilenameWithExtension(input, ext);
      // Room must remain for " (9999)" without breaching 255 bytes.
      expect(bytesOf(`${name} (9999)`)).toBeLessThanOrEqual(MAX_COMPONENT_BYTES);
    }
  });

  it('truncates on code points, never mid-surrogate', () => {
    // Slicing UTF-16 code units would split an emoji and leave a lone
    // surrogate, which surfaces downstream as U+FFFD in the filename.
    const name = safeFilename('😀'.repeat(400));
    expect(name).not.toContain('�');
    for (const ch of name) expect(ch).toBe('😀');
    // Round-tripping through UTF-8 must be lossless.
    expect(Buffer.from(name, 'utf8').toString('utf8')).toBe(name);
  });

  it('counts bytes, not characters, for multibyte titles', () => {
    // 200 emoji are 800 UTF-8 bytes but only 200 code points; a code-point
    // cap alone would sail past the filesystem limit.
    expect(bytesOf(safeFilename('😀'.repeat(200)))).toBeLessThanOrEqual(MAX_COMPONENT_BYTES - 8);
  });

  it('keeps deduped names inside the ceiling', () => {
    const name = safeFilenameWithExtension('日'.repeat(400), '.md');
    const taken = new Set([name]);
    expect(bytesOf(dedupeFilename(name, taken))).toBeLessThanOrEqual(MAX_COMPONENT_BYTES);
  });

  it('does not leave a dangling space where truncation landed', () => {
    const name = safeFilename(`${'a'.repeat(118)} tail`);
    expect(name).toBe(name.trimEnd());
  });
});

describe('dedupeFilename', () => {
  it('leaves a free name alone', () => {
    expect(dedupeFilename('Notes.md', new Set())).toBe('Notes.md');
  });

  it('suffixes deterministically before the extension', () => {
    expect(dedupeFilename('Notes.md', new Set(['Notes.md']))).toBe('Notes (2).md');
    expect(dedupeFilename('Notes.md', new Set(['Notes.md', 'Notes (2).md']))).toBe('Notes (3).md');
  });

  it('handles names with no extension', () => {
    expect(dedupeFilename('Notes', new Set(['Notes']))).toBe('Notes (2)');
  });

  it('treats the reservation set as the authority, not the disk', () => {
    // Names reserved earlier in the same run usually are not written yet.
    const taken = new Set<string>();
    const first = dedupeFilename('a.md', taken);
    taken.add(first);
    const second = dedupeFilename('a.md', taken);
    taken.add(second);
    expect([first, second]).toEqual(['a.md', 'a (2).md']);
  });
});
