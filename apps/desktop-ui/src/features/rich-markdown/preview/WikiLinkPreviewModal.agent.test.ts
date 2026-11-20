/**
 * The agent preview's frame: set wide outright (the unstyled Modal's dialog
 * box shrinks to its content, so `width: 100%` alone left it skinny), 840px on
 * a wide window and the window less its gutters on a small one; its height
 * follows its content, except on a tab that fills its host.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const scss = readFileSync(join(__dirname, 'WikiLinkPreviewModal.module.scss'), 'utf8');
function block(selector: string): string {
  const start = scss.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`No ${selector} rule`);
  return scss.slice(start, scss.indexOf('\n}', start));
}

describe('agent preview frame', () => {
  it('is 840px wide on a wide window and fits a narrow one', () => {
    const agent = block('.panelKind-agent');
    expect(agent).toMatch(
      /\n {2}width: min\(#\{unzoomed\(840px\)\}, calc\(#\{window-vw\(100\)\} - 2 \* var\(--overlay-pad\)\)\);/
    );
    expect(agent).toMatch(/\n {2}max-width: unzoomed\(840px\);/);
    // Its height still follows its content.
    expect(agent).toMatch(/\n {2}height: auto;/);
  });

  // A tab that fills its host (Direct messages: a chat) has no content height
  // to flow to; with `height: auto` the chat collapsed to its header strip.
  // AgentView marks such a tab with `data-fills-host` and the card then takes
  // the frame's full height, its view filling the body again.
  it('takes the full frame height while its view fills its host', () => {
    const agent = block('.panelKind-agent');
    const fill = agent.slice(agent.indexOf('&:has([data-fills-host]) {'));
    expect(fill).toMatch(/^&:has\(\[data-fills-host\]\) \{\n {4}height: \$frame-height;/);
    expect(fill).toMatch(/\.bodyView > \* \{\n {6}flex: 1;\n {6}min-height: 0;/);
    // The same height the wide frame always has.
    expect(block('.panelWide')).toMatch(/\n {2}height: \$frame-height;/);
    expect(scss).toMatch(
      /\n\$frame-height: min\(window-vh\(80\), calc\(#\{window-dvh\(100\)\} - 2 \* var\(--overlay-pad\)\)\);/
    );
  });
});
