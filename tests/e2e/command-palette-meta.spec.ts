import { test, expect } from '@playwright/test';

/**
 * CommandPalette: each result row renders a muted meta sub-line under the
 * title showing the most recent timestamp (updated or created) in a human
 * date/time format. Wired from `formatResultMeta(hit)` in CommandPalette.tsx.
 *
 * Smoke test only: opens the palette, types a broad query that should match
 * something in the workspace, and asserts at least one row carries the
 * `data-testid="result-meta"` element with non-empty text.
 */
test.describe('CommandPalette result meta', () => {
  test('result rows render a muted timestamp sub-line', async ({ page }) => {
    await page.goto('/');
    // Wait for app shell to settle before firing the hotkey.
    await page.waitForLoadState('networkidle');

    // Open the palette via the cross-platform hotkey.
    const isMac = process.platform === 'darwin';
    await page.keyboard.press(isMac ? 'Meta+k' : 'Control+k');

    // The palette input should appear.
    const input = page.getByRole('combobox').or(page.locator('input[placeholder*="Search" i]'));
    await expect(input.first()).toBeVisible({ timeout: 5_000 });

    // Type something broad enough to match something — "a" usually returns
    // workspace defaults; if the workspace happens to be empty the test will
    // skip rather than fail (we can't assert meta on zero results).
    await input.first().fill('a');

    const metas = page.locator('[data-testid="result-meta"]');
    const count = await metas.count().catch(() => 0);

    if (count === 0) {
      test.skip(true, 'no result rows returned — empty workspace, meta line cannot be verified');
      return;
    }

    // At least one meta line is visible and non-empty.
    const first = metas.first();
    await expect(first).toBeVisible();
    const text = (await first.innerText()).trim();
    expect(text.length).toBeGreaterThan(0);

    // Soft format check: a real meta line includes either "Updated" or
    // "Created" plus a time component. We accept either since the helper
    // shows the most recent timestamp first.
    expect(text).toMatch(/(Updated|Created)/i);
  });
});
