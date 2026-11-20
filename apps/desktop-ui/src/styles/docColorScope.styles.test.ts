// Theme guard — the Doc color recolors docs, nothing else.
//
// `--color-node-doc` is the user's Doc color (Settings → Theme, and agents'
// change_color_theme). Calendar blue, blue select options, info states and
// project-file panes read their own fixed blue (`--color-select-blue`, the
// default Doc color's hex), so changing the Doc color does not recolor them.
//
// DOC_SURFACES is the reviewed list of files that may read the Doc color,
// each because it paints doc icons or doc pills. Adding a file is a review
// decision: a surface that is not about docs wants its own token.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(process.cwd(), '../..');
const SCAN_ROOTS = ['apps/desktop-ui/src', 'packages/ui'];
// The generated color layer (@snaglet/theme) declares the Doc color.
const TOKENS_FILE = 'packages/theme/tokens.scss';
const DOC_TOKEN = '--color-node-doc';

const DOC_SURFACES = new Map<string, string>([
  ['apps/desktop-ui/src/features/workspace-tree/WorkspaceTree.module.scss', 'tree doc rows'],
  ['apps/desktop-ui/src/pages/Dashboard/chrome/PaneChrome/PaneChrome.module.scss', 'doc pane icon'],
  [
    'apps/desktop-ui/src/pages/Dashboard/chrome/PaneHistoryNav/PaneHistoryNav.module.scss',
    'doc entries in the back/forward menu',
  ],
  [
    'apps/desktop-ui/src/pages/Dashboard/components/CommandPalette/CommandPalette.module.scss',
    'doc results in the command palette',
  ],
  [
    'apps/desktop-ui/src/pages/Dashboard/views/ContainerView/ContainerView.module.scss',
    'doc cards and rows in a container',
  ],
  [
    'apps/desktop-ui/src/features/rich-markdown/preview/WikiLinkPreviewModal.module.scss',
    'doc link preview icon',
  ],
  ['apps/desktop-ui/src/styles/globals/_node-chips.scss', 'doc pills (chips)'],
  [
    'apps/desktop-ui/src/pages/Dashboard/views/HubView/HubView.module.scss',
    'doc rows and pinned doc tiles on Home',
  ],
]);

const collect = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (/\.(scss|tsx?)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
};

// Readers inside the scanned app code; the token source itself is not scanned.
const readers = SCAN_ROOTS.flatMap((root) => collect(join(REPO_ROOT, root)))
  .filter((file) => readFileSync(file, 'utf8').includes(`var(${DOC_TOKEN}`))
  .map((file) => relative(REPO_ROOT, file).split(sep).join('/'));

const tokens = new Map(
  [
    ...readFileSync(join(REPO_ROOT, TOKENS_FILE), 'utf8').matchAll(
      /(--[a-z0-9-]+)\s*:\s*([^;]+);/g
    ),
  ].map((m) => [m[1]!, m[2]!] as const)
);
/** Whether a token's value reaches the Doc color through any chain of var()s. */
function followsDoc(name: string, seen = new Set<string>()): boolean {
  if (name === DOC_TOKEN) return true;
  if (seen.has(name)) return false;
  seen.add(name);
  const value = tokens.get(name) ?? '';
  return [...value.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].some((m) => followsDoc(m[1]!, seen));
}

describe('theme guard: Doc color scope', () => {
  it('is read only by doc surfaces', () => {
    expect(readers.filter((file) => !DOC_SURFACES.has(file)).sort()).toEqual([]);
  });

  it('keeps every listed surface honest (no stale entries)', () => {
    expect([...DOC_SURFACES.keys()].filter((file) => !readers.includes(file)).sort()).toEqual([]);
  });

  it('has no token derived from it except its own tint', () => {
    const derived = [...tokens.keys()].filter((name) => name !== DOC_TOKEN && followsDoc(name));
    expect(derived).toEqual([`${DOC_TOKEN}-bg`]);
  });

  it('gives the former borrowers the default Doc color as a blue of their own', () => {
    expect(tokens.get('--color-select-blue')?.trim()).toBe(
      tokens.get(DOC_TOKEN)?.split('//')[0]?.trim()
    );
    for (const name of ['--color-select-blue', '--color-info', '--color-node-file']) {
      expect({ name, followsDoc: followsDoc(name) }).toEqual({ name, followsDoc: false });
    }
  });
});
