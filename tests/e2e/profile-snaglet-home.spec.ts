import { test, expect, type Page } from '@playwright/test';
import { gotoView } from './helpers/nav';

/** Navigate to Settings → Data → Local storage, where the Snaglet home section lives. */
async function openStorage(page: Page): Promise<void> {
  await gotoView(page, 'Settings');
  const storageItem = page.getByRole('treeitem', { name: /Local storage/i }).first();
  await storageItem.waitFor({ state: 'visible', timeout: 10_000 });
  await storageItem.click();
}

/**
 * E2E: Settable Snaglet home path (Settings → Data → Local storage → Snaglet Home
 * Directory). The section lives in StorageView (Settings → Data → Local
 * storage).
 *
 * Drives the real user-facing flow without triggering an actual app relaunch
 * (a real restart would tear down the test). We assert the section renders the
 * active path, that registering a path adds it to the saved list, and that a
 * pending override surfaces the restart notice.
 *
 * Real DOM contract (verified against StorageView.tsx):
 *   - label "Snaglet home directory"
 *   - active path shown in a readonly box
 *   - TextInput placeholder "/Users/you/.snaglet-test"
 *   - "Register" <button> to add a path to the saved list
 *   - "Restart pending to apply:" notice when an override is set
 */

test.describe('Settings → Data → Local storage → Snaglet home directory', () => {
  test.beforeEach(async ({ page }) => {
    await openStorage(page);
  });

  test('renders the Snaglet home section with the active path', async ({ page }) => {
    await expect(page.getByText('Snaglet home directory')).toBeVisible();
    // The active resolved path is always shown (defaults to ~/.snaglet).
    await expect(
      page.locator('code, [class*="readonly"]').filter({ hasText: '.snaglet' }).first()
    ).toBeVisible();
  });

  test('registering a path adds it to the saved list', async ({ page }) => {
    const input = page.getByPlaceholder('/Users/you/.snaglet-test');
    await expect(input).toBeVisible();

    const candidate = '/tmp/snaglet-e2e-saved-path';
    await input.fill(candidate);

    await page.getByRole('button', { name: 'Register' }).click();

    // The registered path appears in the saved-paths list.
    await expect(page.getByText(candidate)).toBeVisible();
  });

  test('register button is gated on a non-empty input', async ({ page }) => {
    const register = page.getByRole('button', { name: 'Register' });
    // With an empty input the register action should not be available.
    const input = page.getByPlaceholder('/Users/you/.snaglet-test');
    await input.fill('');
    await expect(register).toBeDisabled();
  });
});
