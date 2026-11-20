import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

/** The z-index declared in the first `selector { … }` rule of `source`. */
function zIndexOf(source: string, selector: string): number {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{[^}]*?z-index:\\s*(\\d+)`, 's'));
  if (!match) throw new Error(`no z-index for ${selector}`);
  return Number(match[1]);
}

describe('DocView Versions list stacking', () => {
  // All three are position:fixed children of <body>, so z-index alone decides
  // the order; DOM order only breaks ties.
  const versionsList = () =>
    zIndexOf(read('src/pages/Dashboard/views/DetailRouter.module.scss'), '.docVersionsMenu');
  const chipPreview = () =>
    zIndexOf(
      read('src/features/rich-markdown/preview/WikiLinkPreviewModal.module.scss'),
      '.overlay'
    );
  const confirmation = () =>
    zIndexOf(read('src/components/Modal/Modal.module.scss'), '.overlay.confirmOverlay');

  it('opens above the doc-chip preview that can host a DocView', () => {
    expect(versionsList()).toBeGreaterThan(chipPreview());
  });

  it('stays below the Clear all confirmation it opens', () => {
    expect(confirmation()).toBeGreaterThan(versionsList());
  });
});
