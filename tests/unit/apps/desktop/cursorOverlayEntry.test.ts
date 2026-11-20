import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The native overlay window loads `/?cursorOverlay=1`. If the UI entry does not
 * route that to the transparent standalone page, the window shows the whole app
 * over the user's screen (this happened once). Pin the wiring on both sides.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('cursor overlay entry', () => {
  it('routes ?cursorOverlay to the standalone page, not the app', () => {
    const main = read('apps/desktop-ui/src/main.tsx');
    expect(main).toMatch(/has\('cursorOverlay'\)/);
    expect(main).toMatch(
      /isCursorOverlay\s*\?\s*\(?\s*<CursorOverlayStandalone\s*\/>\s*\)?\s*:\s*isAskOverlay\s*\?\s*\(?\s*<AskOverlayStandalone\s*\/>\s*\)?\s*:\s*\(?\s*<App\s*\/>/
    );
  });

  it('the standalone page marks itself so the native window may show', () => {
    const page = read('apps/desktop-ui/src/CursorOverlayStandalone.tsx');
    expect(page).toContain("setAttribute('data-snaglet-cursor-overlay', '1')");
  });

  it('the native window starts invisible and shows only on that marker', () => {
    const swift = read('apps/server/native/cursor-overlay/CursorOverlay.swift');
    expect(swift).toMatch(/window\.alphaValue\s*=\s*0/);
    expect(swift).toContain('data-snaglet-cursor-overlay');
    expect(swift).toMatch(/\(result as\? String\) == "1"/);
    expect(swift).toMatch(/alphaValue = ready \? 1 : 0/);
  });

  it('the native window stays hidden while a Vite error overlay is present', () => {
    const swift = read('apps/server/native/cursor-overlay/CursorOverlay.swift');
    expect(swift).toContain("!document.querySelector('vite-error-overlay')");
  });
});
