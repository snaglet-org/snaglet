import { test, expect } from '@playwright/test';
import { createChatWithAgent, getAgents } from './helpers/chat';

/**
 * Mention popup position in the chat composer (the real surface).
 *
 * When the user opens the @-mention menu from the composer, the popup must
 * stay inside the viewport: rendered above the caret with no flip/clamp, it
 * would clip off-screen when the composer is near the top of the viewport.
 *
 * This spec opens a thread, types `@` into the composer to surface the
 * suggestion popup, captures the popup rect, and asserts it is inside the
 * viewport (top >= 0, bottom <= h, left >= 0, right <= w). It also writes a
 * screenshot + JSON probe artifact for visual review when the assertion is
 * loosened during investigation.
 */

const SHOTS = 'tests/e2e/__screenshots__/mention-popup';

test('mention popup position — chat composer stays inside viewport', async ({ page }, testInfo) => {
  const agents = await getAgents();
  if (agents.length === 0) {
    test.skip(true, 'No agents available in this workspace; cannot create a chat fixture.');
    return;
  }
  const agent = agents[0];

  const { composer } = await createChatWithAgent(page, agent.name);
  await expect(composer).toBeVisible();

  await composer.click();
  await page.keyboard.type('@');

  const popup = page.getByRole('listbox', { name: 'Mention suggestions' });
  await expect(popup).toBeVisible();

  await page.screenshot({ path: `${SHOTS}-chat-composer.png`, fullPage: false });

  const probe = await page.evaluate(() => {
    const list = document.querySelector('[aria-label="Mention suggestions"]');
    const comp = document.querySelector('[aria-label="Message composer"]');
    const r = list?.getBoundingClientRect();
    const c = comp?.getBoundingClientRect();
    const sel = window.getSelection();
    let caret: { top: number; left: number; bottom: number } | null = null;
    if (sel && sel.rangeCount > 0) {
      const cr = sel.getRangeAt(0).getBoundingClientRect();
      caret = { top: cr.top, left: cr.left, bottom: cr.bottom };
    }
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      popup: r && {
        top: r.top,
        left: r.left,
        bottom: r.bottom,
        right: r.right,
        w: r.width,
        h: r.height,
      },
      composer: c && { top: c.top, left: c.left, bottom: c.bottom },
      caret,
    };
  });

  console.log('[chat-mention probe]', JSON.stringify(probe, null, 2));
  await testInfo.attach('chat-mention-probe.json', {
    body: JSON.stringify(probe, null, 2),
    contentType: 'application/json',
  });

  expect(probe.popup, 'popup should have a rect').toBeTruthy();
  const p = probe.popup!;
  const v = probe.viewport;

  // Hard assertions — the bug shape we're guarding against is the popup
  // being clipped above the viewport (negative top) or off any other edge.
  // 1px tolerance for subpixel rounding.
  expect(p.top, 'popup.top inside viewport').toBeGreaterThanOrEqual(-1);
  expect(p.bottom, 'popup.bottom inside viewport').toBeLessThanOrEqual(v.h + 1);
  expect(p.left, 'popup.left inside viewport').toBeGreaterThanOrEqual(-1);
  expect(p.right, 'popup.right inside viewport').toBeLessThanOrEqual(v.w + 1);
});
