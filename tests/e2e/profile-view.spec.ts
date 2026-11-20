import { test, expect } from '@playwright/test';
import { gotoView } from './helpers/nav';

/**
 * Coverage-hunt spec: ProfileView (Settings → Profile).
 *
 * Drives the real user flow:
 *   open Settings → click Profile → edit name → assert dirty-state Save gating
 *   → save → assert persisted across a reload.
 *
 * Real DOM contract (verified against ProfileView.tsx):
 *   - header <h1> "My profile"
 *   - TextInput#profile-name (the display name)
 *   - footer status <span aria-live="polite"> → "" (idle) | "Unsaved changes" | "Saved"
 *   - Save <button> accessible-name "Save", disabled={!dirty}
 *     where dirty = name !== profile.name || email !== profile.email
 */

async function openProfile(page: import('@playwright/test').Page) {
  const header = page.getByRole('heading', { name: 'My profile' });
  // The app may deep-restore ProfileView directly (e.g. after a reload), in which
  // case the header rehydrates after a short delay and the Settings sidebar treeitem
  // may not be rendered. Give the restore a beat; only drive the sidebar nav if the
  // header never appears on its own.
  if (
    await header
      .waitFor({ state: 'visible', timeout: 3_000 })
      .then(() => true)
      .catch(() => false)
  )
    return;

  await gotoView(page, 'Settings');
  // Settings sidebar renders a tree; the Profile entry is a treeitem labeled "profile".
  const profileItem = page.getByRole('treeitem', { name: /profile/i }).first();
  await profileItem.waitFor({ state: 'visible', timeout: 10_000 });
  await profileItem.click();
  // Main panel now shows the ProfileView header.
  await expect(header).toBeVisible({ timeout: 10_000 });
}

test.describe('ProfileView', () => {
  test('Save is disabled when the form is clean (no edits)', async ({ page }) => {
    await page.goto('/');
    await openProfile(page);

    const status = page.locator('span[aria-live="polite"]');
    // Idle renders nothing — an untouched form has no status to announce.
    await expect(status).toHaveText('');

    const save = page.getByRole('button', { name: 'Save', exact: true });
    await expect(save).toBeDisabled();
  });

  test('editing the name enables Save and flips status to "Unsaved changes"', async ({ page }) => {
    await page.goto('/');
    await openProfile(page);

    const nameInput = page.locator('#profile-name');
    await expect(nameInput).toBeVisible();
    const original = (await nameInput.inputValue()).trim();
    const edited = `${original || 'User'} ✎`;

    await nameInput.fill(edited);

    // Dirty state: status flips and Save enables.
    await expect(page.locator('span[aria-live="polite"]')).toHaveText(/unsaved changes/i);
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  });

  test('reverting the edit back to the original clears the dirty state', async ({ page }) => {
    await page.goto('/');
    await openProfile(page);

    const nameInput = page.locator('#profile-name');
    const original = await nameInput.inputValue();

    await nameInput.fill(`${original}xyz`);
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();

    // Revert to the exact original — dirty should clear, Save should disable again.
    await nameInput.fill(original);
    // Back to clean ⇒ back to the silent idle state, not a label.
    await expect(page.locator('span[aria-live="polite"]')).toHaveText('');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  });

  test('saving an edited name persists across a reload', async ({ page }) => {
    await page.goto('/');
    await openProfile(page);

    const nameInput = page.locator('#profile-name');
    const original = (await nameInput.inputValue()).trim();
    const marker = `QA${Date.now() % 100000}`;
    const edited = `${original.replace(/ QA\d+$/, '')} ${marker}`.trim();

    await nameInput.fill(edited);
    const save = page.getByRole('button', { name: 'Save', exact: true });
    await expect(save).toBeEnabled();
    await save.click();

    // After save, status reflects success and dirty clears (Save disabled again).
    // Anchored, because /saved/i alone also matches "Unsaved changes". Only the
    // literal "Saved" state is success.
    await expect(page.locator('span[aria-live="polite"]')).toHaveText(/^saved$/i, {
      timeout: 10_000,
    });
    await expect(save).toBeDisabled({ timeout: 10_000 });

    // Persistence: reload, reopen Profile, the saved name is still there.
    await page.reload();
    await openProfile(page);
    await expect(page.locator('#profile-name')).toHaveValue(edited, { timeout: 10_000 });
  });
});
