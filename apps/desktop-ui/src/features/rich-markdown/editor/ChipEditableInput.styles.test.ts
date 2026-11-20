import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(
  resolve(process.cwd(), 'src/features/rich-markdown/editor/ChipEditableInput.module.scss'),
  'utf8'
);

/** The stylesheet without comments, so only real selectors are checked. */
const rules = styles.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('ChipEditableInput placeholder styles', () => {
  it("targets Tiptap's unhashed empty-editor class so placeholders render", () => {
    // CSS modules rename every local class; Tiptap adds `is-editor-empty`
    // itself, so a bare `.is-editor-empty` selector would never match.
    expect(rules).toMatch(
      /p:global\(\.is-editor-empty\):first-child::before\s*\{[^}]*content: attr\(data-placeholder\)/
    );
    expect(rules.replace(/:global\(\.is-editor-empty\)/g, '')).not.toContain('.is-editor-empty');
  });
});

describe('table control styles', () => {
  /** The declarations of the first rule whose selector list is exactly `selector`. */
  const block = (selector: string) => {
    const at = rules.indexOf(`${selector} {`);
    expect(at).toBeGreaterThanOrEqual(0);
    return rules.slice(at, rules.indexOf('}', at));
  };

  it('keeps the × and Expand inside the table’s corner, off the blocks around it', () => {
    const shared = block(':global(.tableDelete),\n  :global(.tableBar)');
    expect(shared).toMatch(/position: absolute;/);
    expect(shared).toMatch(/top: 3px;/);
    // Hidden controls let the pointer through to the header under them.
    expect(shared).toMatch(/pointer-events: none;/);
    const controls = rules.slice(rules.indexOf(':global(.tableDelete),'), rules.indexOf('table {'));
    expect(controls).not.toMatch(/bottom: 100%|top: -|right: -/);
  });
});
