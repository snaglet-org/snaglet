import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(
  resolve(process.cwd(), 'src/features/rich-markdown/workspace-editor/WorkspaceEditor.module.scss'),
  'utf8'
);

/** The stylesheet without comments, so only real declarations are checked. */
const rules = styles.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('markdown view styles', () => {
  it('scrolls the styled backdrop instantly, so it never lags the textarea', () => {
    // The app sets `scroll-behavior: smooth` on every element; the backdrop
    // copies the textarea's scrollTop on each scroll and must land at once.
    expect(rules).toMatch(/\.sourceBackdrop\s*\{[^}]*scroll-behavior:\s*auto/);
  });
});
