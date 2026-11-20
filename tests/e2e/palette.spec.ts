import { test, expect } from '@playwright/test';
import { openApp } from './helpers/nav';
import { createDoc, deleteDoc, runPrefix, expectAppAlive, type DocRec } from './helpers/workspace';

/**
 * Command Palette (Cmd/Ctrl+K): opens without blanking the screen, surfaces a keyword-tier result for a seeded doc, and
 * closes on Escape.
 *
 * Behavior only: we assert the dialog opens, a result option for the seeded
 * doc appears, and the app survives — never ordering, scores, or layout.
 */
test.describe('Command Palette — open, keyword result, close', () => {
  const prefix = runPrefix('palette');
  let seeded: DocRec;

  test.beforeAll(async () => {
    // Unique title so exactly one result matches the search term.
    seeded = await createDoc({ title: `${prefix}-findme` });
  });

  test.afterAll(async () => {
    await deleteDoc(seeded?.id);
  });

  test('Cmd+K opens (no crash), matches a seeded doc, Esc closes', async ({ page }) => {
    await openApp(page);
    const isMac = process.platform === 'darwin';

    // Open — the dialog must appear and the app must not blank out.
    await page.keyboard.press(isMac ? 'Meta+k' : 'Control+k');
    const dialog = page.getByRole('dialog', { name: 'Quick search' });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expectAppAlive(page);

    // Type the seeded term → a result option for that doc appears (instant
    // keyword/lexical tier — no dependence on ordering or scores).
    await page.getByRole('textbox', { name: 'Quick search' }).fill(`${prefix}-findme`);
    await expect(dialog.getByRole('option', { name: `${prefix}-findme` }).first()).toBeVisible({
      timeout: 15_000,
    });

    // Escape closes the palette; the app is still alive.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await expectAppAlive(page);
  });
});
