import { expect, test, type Locator } from '@playwright/test';
import { openApp } from './helpers/nav';

const PANE_ITEM_MIME = 'application/x-snaglet-pane-item';

/**
 * Pane depth hierarchy — visual verification
 *
 * Active pane should feel "inset" (into the desk); inactive panes should
 * feel "outset" (floating above). This creates instant spatial awareness
 * of focus without requiring labels or heavy borders.
 *
 * Uses stable `[data-leaf-id]` selectors and deterministic pane creation
 * via synthetic drop events (same pattern as pane-layout-invariants.spec.ts).
 */

/**
 * Drop a "providers" pane to the right edge of the target pane, creating
 * a new split. Uses synthetic drag/drop events to avoid flake from real
 * mouse drags.
 */
async function dropProviderPaneToRight(pane: Locator): Promise<void> {
  await pane.evaluate(
    (element, { mime }) => {
      const rect = element.getBoundingClientRect();
      const dataTransfer = new DataTransfer();
      dataTransfer.setData(mime, JSON.stringify({ kind: 'providers' }));
      const eventInit: DragEventInit = {
        bubbles: true,
        cancelable: true,
        clientX: rect.right - 2, // right edge = right-zone drop
        clientY: rect.top + rect.height / 2,
        dataTransfer,
      };
      element.dispatchEvent(new DragEvent('dragover', eventInit));
      element.dispatchEvent(new DragEvent('drop', eventInit));
    },
    { mime: PANE_ITEM_MIME }
  );
}

test.describe('Pane depth hierarchy', () => {
  test('active pane has inset shadow; inactive pane has outset shadow', async ({ page }) => {
    await openApp(page);

    // Start with a single pane
    const panes = page.locator('[data-leaf-id]');
    await expect(panes).toHaveCount(1);

    // Deterministically create a second pane via right-drop
    await dropProviderPaneToRight(panes.first());
    await expect(panes).toHaveCount(2);

    // The newly created pane becomes active (right pane after split)
    const allPanes = await panes.all();
    expect(allPanes.length).toBe(2);

    // Identify active vs. inactive pane using class presence
    const pane0IsActive = await allPanes[0].evaluate((el) => el.className.includes('paneActive'));
    const pane1IsActive = await allPanes[1].evaluate((el) => el.className.includes('paneActive'));

    // Exactly one pane should be active
    expect(pane0IsActive || pane1IsActive).toBe(true);
    expect(pane0IsActive && pane1IsActive).toBe(false);

    const activePane = pane0IsActive ? allPanes[0] : allPanes[1];
    const inactivePane = pane0IsActive ? allPanes[1] : allPanes[0];

    // Verify active pane has inset shadow (contains "inset" keyword)
    const activeShadow = await activePane.evaluate((el) => window.getComputedStyle(el).boxShadow);
    expect(activeShadow).toContain('inset');

    // Should have at least 2 inset shadows (accent ring + depth layers)
    const insetCount = (activeShadow.match(/inset/g) || []).length;
    expect(insetCount).toBeGreaterThanOrEqual(2);

    // Verify inactive pane has outset shadow (NO "inset" keyword)
    const inactiveShadow = await inactivePane.evaluate(
      (el) => window.getComputedStyle(el).boxShadow
    );
    expect(inactiveShadow).not.toContain('inset');
    expect(inactiveShadow).not.toBe('none'); // Should have some shadow depth
  });

  test('clicking inactive pane swaps active/inactive shadow states', async ({ page }) => {
    await openApp(page);

    const panes = page.locator('[data-leaf-id]');
    await expect(panes).toHaveCount(1);

    // Create a second pane
    await dropProviderPaneToRight(panes.first());
    await expect(panes).toHaveCount(2);

    const allPanes = await panes.all();

    // Identify initial active/inactive panes
    const pane0IsActive = await allPanes[0].evaluate((el) => el.className.includes('paneActive'));
    const initialActivePane = pane0IsActive ? allPanes[0] : allPanes[1];
    const initialInactivePane = pane0IsActive ? allPanes[1] : allPanes[0];

    // Verify initial state
    const initialActiveShadow = await initialActivePane.evaluate(
      (el) => window.getComputedStyle(el).boxShadow
    );
    const initialInactiveShadow = await initialInactivePane.evaluate(
      (el) => window.getComputedStyle(el).boxShadow
    );
    expect(initialActiveShadow).toContain('inset');
    expect(initialInactiveShadow).not.toContain('inset');

    // Click the inactive pane to activate it
    await initialInactivePane.click();

    // Wait for the DOM to settle (class swap happens synchronously, but
    // wait a frame to let any transitions start)
    await page.waitForTimeout(50);

    // Verify the states swapped
    const newActiveShadow = await initialInactivePane.evaluate(
      (el) => window.getComputedStyle(el).boxShadow
    );
    const newInactiveShadow = await initialActivePane.evaluate(
      (el) => window.getComputedStyle(el).boxShadow
    );

    expect(newActiveShadow).toContain('inset'); // now active → inset
    expect(newInactiveShadow).not.toContain('inset'); // now inactive → outset
  });

  test('prefers-reduced-motion disables shadow transitions on pane root', async ({ page }) => {
    // Emulate prefers-reduced-motion at the page level before navigation
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await openApp(page);

    // Get a real pane root using the stable selector
    const paneRoot = page.locator('[data-leaf-id]').first();
    await expect(paneRoot).toBeVisible();

    // Verify the pane root has no transition (or transition: none)
    const transition = await paneRoot.evaluate((el) => window.getComputedStyle(el).transition);

    // With prefers-reduced-motion, PaneChrome.module.scss should set
    // `transition: none` on the .pane root. Browsers may append a tiny
    // epsilon duration (e.g. "none 1e-05s") due to CSS animation quirks;
    // we accept both "none" and "none" followed by near-zero timing.
    expect(transition === 'none' || transition.startsWith('none 1e-0')).toBe(true);
  });
});
