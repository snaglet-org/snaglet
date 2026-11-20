/**
 * Unit tests for exclusions — the two-layer file denylist.
 *
 * Layer 1 (hardcoded) must keep working with no rules passed. Layer 2 (the
 * per-project `ignorePaths`/`ignoreFileTypes` from snaglet.config.json) is compiled
 * by compileIgnoreRules and must be additive: it extends the base denylist and
 * matches the path forms users actually write (folder, folder/*, glob, exact
 * file, extension with or without a dot).
 */

import { describe, expect, it } from '@jest/globals';
import path from 'node:path';
import { AUTO_SKIP_FILE_EXTENSIONS } from '@snaglet/shared/constants';
import {
  compileIgnoreRules,
  shouldExcludePath,
  EMPTY_IGNORE_RULES,
} from '@server/services/fileIndexing/exclusions';

const rel = (...parts: string[]) => path.join(...parts);

describe('compileIgnoreRules', () => {
  it('normalizes path patterns (strips ./, trailing /* and /, backslashes)', () => {
    const rules = compileIgnoreRules({
      ignorePaths: ['.playwright-mcp/*', './docs/generated/', 'dist', 'a\\b', '   ', ''],
    });
    expect(rules.paths).toEqual(['.playwright-mcp', 'docs/generated', 'dist', 'a/b']);
    expect(rules.pathMatchers).toHaveLength(4);
  });

  it('normalizes file types (lowercase, drops leading dot and blanks)', () => {
    const rules = compileIgnoreRules({ ignoreFileTypes: ['PNG', '.Jpg', 'csv', ' ', ''] });
    expect([...rules.fileTypes].sort()).toEqual(['csv', 'jpg', 'png']);
  });

  it('tolerates missing arrays', () => {
    expect(compileIgnoreRules({})).toEqual({
      includePaths: [],
      includePathMatchers: [],
      paths: [],
      pathMatchers: [],
      fileTypes: new Set(),
    });
  });
});

describe('shouldExcludePath — base layer (no rules)', () => {
  it('keeps ordinary source files', () => {
    expect(shouldExcludePath(rel('src', 'index.ts'))).toBe(false);
  });

  it('still excludes hardcoded dirs, dotfiles, lockfiles, the gate, and media', () => {
    expect(shouldExcludePath(rel('node_modules', 'x', 'y.js'))).toBe(true);
    expect(shouldExcludePath(rel('dist', 'app.js'))).toBe(true);
    expect(shouldExcludePath('.env')).toBe(true);
    expect(shouldExcludePath('pnpm-lock.yaml')).toBe(true);
    expect(shouldExcludePath('snaglet.config.json')).toBe(true);
    expect(shouldExcludePath(rel('assets', 'logo.png'))).toBe(true);
  });
});

describe('shouldExcludePath — binary/non-text auto-skip (independent of user config)', () => {
  // Binary / non-text files (images, Office docs) can never be usefully
  // embedded, so they are always skipped, never a user-removable choice. This
  // holds even when the user's ignore list is empty or a stored config never
  // listed them.
  it('skips binary/non-text files even with an empty user ignore list', () => {
    const emptyCompiled = compileIgnoreRules({ ignorePaths: [], ignoreFileTypes: [] });
    for (const rules of [undefined, EMPTY_IGNORE_RULES, emptyCompiled]) {
      expect(shouldExcludePath(rel('assets', 'logo.png'), rules)).toBe(true);
      expect(shouldExcludePath(rel('slides', 'deck.pptx'), rules)).toBe(true);
      expect(shouldExcludePath(rel('data', 'book.xlsx'), rules)).toBe(true);
    }
  });

  it('auto-skips every canonical AUTO_SKIP_FILE_EXTENSIONS entry with no rules', () => {
    for (const ext of AUTO_SKIP_FILE_EXTENSIONS) {
      expect(shouldExcludePath(rel('some', `file.${ext}`))).toBe(true);
    }
  });

  it('still indexes genuinely text-ish files not in the auto-skip set', () => {
    expect(shouldExcludePath(rel('data', 'rows.csv'))).toBe(false);
    expect(shouldExcludePath(rel('src', 'main.ts'))).toBe(false);
  });

  // PDFs are extractable, not auto-skipped: discovery accepts them and the
  // read step derives a text layer — but a user's `ignoreFileTypes: ["pdf"]`
  // must still opt a project out (additive layer 2).
  it('accepts PDFs by default; user ignoreFileTypes still excludes them', () => {
    for (const rules of [undefined, EMPTY_IGNORE_RULES]) {
      expect(shouldExcludePath(rel('docs', 'report.pdf'), rules)).toBe(false);
      expect(shouldExcludePath(rel('docs', 'REPORT.PDF'), rules)).toBe(false);
    }
    const userIgnored = compileIgnoreRules({ ignoreFileTypes: ['pdf'] });
    expect(shouldExcludePath(rel('docs', 'report.pdf'), userIgnored)).toBe(true);
    expect(shouldExcludePath(rel('docs', 'REPORT.PDF'), userIgnored)).toBe(true);
    const dotted = compileIgnoreRules({ ignoreFileTypes: ['.PDF'] });
    expect(shouldExcludePath(rel('docs', 'report.pdf'), dotted)).toBe(true);
  });
});

describe('shouldExcludePath — user rules (additive)', () => {
  it('excludes an entire folder and everything under it', () => {
    const rules = compileIgnoreRules({ ignorePaths: ['vendor', 'docs/generated'] });
    expect(shouldExcludePath('vendor', rules)).toBe(true); // the dir itself (pruned in walk)
    expect(shouldExcludePath(rel('vendor', 'lib', 'a.go'), rules)).toBe(true);
    expect(shouldExcludePath(rel('docs', 'generated', 'api.md'), rules)).toBe(true);
    expect(shouldExcludePath(rel('docs', 'guide.md'), rules)).toBe(false); // sibling kept
  });

  it('treats folder and folder/* the same', () => {
    const rules = compileIgnoreRules({ ignorePaths: ['build/*'] });
    expect(shouldExcludePath(rel('build', 'out.js'), rules)).toBe(true);
  });

  it('supports folder names and path sequences at any depth with **', () => {
    const rules = compileIgnoreRules({ ignorePaths: ['**/generated', '**/fixtures/cache'] });
    expect(shouldExcludePath(rel('generated', 'api.ts'), rules)).toBe(true);
    expect(shouldExcludePath(rel('apps', 'web', 'generated', 'api.ts'), rules)).toBe(true);
    expect(shouldExcludePath(rel('fixtures', 'cache', 'item.json'), rules)).toBe(true);
    expect(shouldExcludePath(rel('packages', 'a', 'fixtures', 'cache', 'item.json'), rules)).toBe(
      true
    );
    expect(shouldExcludePath(rel('src', 'generated-client.ts'), rules)).toBe(false);
  });

  it('uses * for exactly one path segment', () => {
    const rules = compileIgnoreRules({ ignorePaths: ['*/generated'] });
    expect(shouldExcludePath(rel('apps', 'generated', 'api.ts'), rules)).toBe(true);
    expect(shouldExcludePath(rel('generated', 'api.ts'), rules)).toBe(false);
    expect(shouldExcludePath(rel('apps', 'web', 'generated', 'api.ts'), rules)).toBe(false);
  });

  it('supports filename wildcards, character classes, and brace groups', () => {
    const rules = compileIgnoreRules({
      ignorePaths: ['**/*.snap', '**/debug-?.trace', '**/*.{tmp,bak}', '**/fixture-[0-9].json'],
    });
    expect(shouldExcludePath(rel('src', '__snapshots__', 'view.snap'), rules)).toBe(true);
    expect(shouldExcludePath(rel('logs', 'debug-1.trace'), rules)).toBe(true);
    expect(shouldExcludePath(rel('cache', 'entry.tmp'), rules)).toBe(true);
    expect(shouldExcludePath(rel('data', 'fixture-4.json'), rules)).toBe(true);
    expect(shouldExcludePath(rel('logs', 'debug-long.trace'), rules)).toBe(false);
    expect(shouldExcludePath(rel('data', 'fixture-a.json'), rules)).toBe(false);
  });

  it('keeps negation additive instead of re-including an ignored path', () => {
    const rules = compileIgnoreRules({ ignorePaths: ['!private'] });
    expect(shouldExcludePath(rel('private', 'secret.md'), rules)).toBe(false);
    expect(shouldExcludePath(rel('!private', 'literal.md'), rules)).toBe(true);
  });

  it('excludes one exact file without touching look-alikes', () => {
    const rules = compileIgnoreRules({ ignorePaths: ['notes/todo.md'] });
    expect(shouldExcludePath(rel('notes', 'todo.md'), rules)).toBe(true);
    expect(shouldExcludePath(rel('notes', 'todo.md.bak'), rules)).toBe(false);
    expect(shouldExcludePath(rel('notes', 'other.md'), rules)).toBe(false);
  });

  it('excludes by file type anywhere in the tree', () => {
    const rules = compileIgnoreRules({ ignoreFileTypes: ['csv'] });
    expect(shouldExcludePath(rel('data', 'rows.csv'), rules)).toBe(true);
    expect(shouldExcludePath(rel('data', 'rows.CSV'), rules)).toBe(true); // case-insensitive
    expect(shouldExcludePath(rel('data', 'rows.json'), rules)).toBe(false);
  });

  it('does not exclude normal files when rules are empty', () => {
    expect(shouldExcludePath(rel('src', 'index.ts'), EMPTY_IGNORE_RULES)).toBe(false);
  });
});

describe('shouldExcludePath — include-only rules', () => {
  it('includes literal roots and everything beneath them', () => {
    const rules = compileIgnoreRules({ includePaths: ['src', 'docs/guides'] });
    expect(shouldExcludePath(rel('src', 'index.ts'), rules)).toBe(false);
    expect(shouldExcludePath(rel('docs', 'guides', 'start.md'), rules)).toBe(false);
    expect(shouldExcludePath(rel('tests', 'index.test.ts'), rules)).toBe(true);
  });

  it('keeps parent directories traversable until a nested include can match', () => {
    const rules = compileIgnoreRules({ includePaths: ['apps/web/src'] });
    expect(shouldExcludePath('apps', rules, 'directory')).toBe(false);
    expect(shouldExcludePath(rel('apps', 'web'), rules, 'directory')).toBe(false);
    expect(shouldExcludePath(rel('apps', 'api'), rules, 'directory')).toBe(true);
    expect(shouldExcludePath(rel('apps', 'web', 'src', 'main.ts'), rules)).toBe(false);
  });

  it('supports include globs while ignore rules still take precedence', () => {
    const rules = compileIgnoreRules({
      includePaths: ['**/src', '**/*.md'],
      ignorePaths: ['**/generated'],
    });
    expect(shouldExcludePath(rel('packages', 'one', 'src'), rules, 'directory')).toBe(false);
    expect(shouldExcludePath(rel('packages', 'one', 'src', 'index.ts'), rules)).toBe(false);
    expect(shouldExcludePath(rel('notes', 'readme.md'), rules)).toBe(false);
    expect(shouldExcludePath(rel('packages', 'one', 'generated', 'readme.md'), rules)).toBe(true);
    expect(shouldExcludePath(rel('assets', 'data.json'), rules)).toBe(true);
  });
});
