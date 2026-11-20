import { test, expect, type Page } from '@playwright/test';
import { openApp } from './helpers/nav';

/**
 * Status-bar reload button + ⌘R hotkey.
 *
 * The packaged Tauri shell has no browser chrome, so the ReloadSlot button in
 * the status bar's right cluster and the ⌘R/Ctrl+R hotkey are the only ways
 * to refresh the UI. Both call one shared `reloadWindow` action.
 *
 * Reload is proven with an in-page marker: a `window` property set before the
 * action must be GONE afterward — only a real document reload clears it.
 */

const RELOAD_BUTTON = { name: 'Reload UI', exact: true } as const;

async function setMarker(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__e2eReloadMarker = true;
  });
}

async function markerPresent(page: Page): Promise<boolean> {
  return await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__e2eReloadMarker === true
  );
}

test.describe('status bar — Reload UI', () => {
  test('button renders in the status bar with the shortcut tooltip', async ({ page }) => {
    await openApp(page);

    const statusBar = page.getByRole('contentinfo', { name: 'Status bar' });
    const button = statusBar.getByRole('button', RELOAD_BUTTON);
    await expect(button).toBeVisible();

    // Hovering surfaces the tooltip bubble carrying the platform shortcut.
    await button.hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(/Reload UI \((⌘R|Ctrl\+R)\)/);
  });

  test('clicking the button really reloads the webview', async ({ page }) => {
    await openApp(page);
    await setMarker(page);
    expect(await markerPresent(page)).toBe(true);

    await Promise.all([page.waitForEvent('load'), page.getByRole('button', RELOAD_BUTTON).click()]);

    // App shell boots again and the pre-reload marker is gone — a real
    // document reload, not a soft refresh.
    await page.getByRole('tab').first().waitFor({ state: 'visible', timeout: 30_000 });
    expect(await markerPresent(page)).toBe(false);
  });

  test('the ⌘R / Ctrl+R hotkey reloads, including while focus is in an editable', async ({
    page,
  }) => {
    await openApp(page);

    // Reload must fire even with focus inside an input (no ignoreInEditable —
    // mirrors the native browser shortcut it stands in for).
    const treeSearch = page.getByRole('textbox', { name: 'Search workspace tree' });
    await treeSearch.click();
    await setMarker(page);

    await Promise.all([page.waitForEvent('load'), page.keyboard.press('Meta+r')]);

    await page.getByRole('tab').first().waitFor({ state: 'visible', timeout: 30_000 });
    expect(await markerPresent(page)).toBe(false);
  });

  test('rapid double-click does not wedge the app — it still boots to a live shell', async ({
    page,
  }) => {
    await openApp(page);
    await setMarker(page);

    const button = page.getByRole('button', RELOAD_BUTTON);
    // Two clicks in quick succession — the second may land on the unloading
    // document; neither may strand the app.
    await Promise.all([
      page.waitForEvent('load'),
      (async () => {
        await button.click();
        await button.click({ timeout: 2_000 }).catch((err: unknown) => {
          // Expected: the first reload may tear the button out from under
          // the second click.
          console.warn('second reload click raced the reload (expected):', err);
        });
      })(),
    ]);

    await page.getByRole('tab').first().waitFor({ state: 'visible', timeout: 30_000 });
    expect(await markerPresent(page)).toBe(false);
    // Shell is interactive after the storm.
    await expect(page.getByRole('contentinfo', { name: 'Status bar' })).toBeVisible();
  });
});
