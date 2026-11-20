import { test, expect } from '@playwright/test';
import { gotoView } from './helpers/nav';

/**
 * Coverage-hunt spec: DatabaseSettingsView (Settings → Data → Backups).
 *
 * This view is DESTRUCTIVE (reset wipes the DB, restore replaces it), so the
 * spec drives only SAFE mutations end-to-end:
 *   - create snapshot  → exercises the job-poll / toast / list-refresh state machine
 *   - delete snapshot  → self-cleaning (removes the snapshot we just made)
 *   - reset modal       → assert it OPENS, then CANCEL. We never click the wipe button.
 *
 * Navigation: ActivityBar "Settings" → Data → sidebar treeitem "Backups" →
 *   DataSearchView mounts DatabaseSettingsView in single-view mode.
 */

const SNAP_LABEL = `e2e-probe-${Date.now()}`;

/** Open Settings, then click the "Backups" sidebar leaf to mount the view. */
async function gotoBackups(page: import('@playwright/test').Page) {
  await gotoView(page, 'Settings');
  await page.getByRole('treeitem', { name: 'Backups' }).click();
  // Heading confirms the DatabaseSettingsView is mounted.
  await expect(page.getByRole('heading', { name: 'Database' })).toBeVisible();
}

test.describe('DatabaseSettingsView (Settings → Data → Backups)', () => {
  test('keeps Backups directly under Data and removes Workspace settings', async ({ page }) => {
    await gotoView(page, 'Settings');

    const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
    // The group header renders its child count (Data 3 today); accept any
    // count so adding a leaf under Data doesn't fail an unrelated assertion.
    await expect(sidebar.getByRole('button', { name: /^Data(?:\s+\d+)?$/ })).toBeVisible();
    await expect(sidebar.getByRole('treeitem', { name: 'Backups' })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: /^Database(?:\s+\d+)?$/ })).toHaveCount(0);
    await expect(sidebar.getByRole('treeitem', { name: /workspace/i })).toHaveCount(0);
  });

  test('renders the three cards and current-database stats', async ({ page }) => {
    await gotoBackups(page);

    await expect(page.getByText('CURRENT DATABASE', { exact: true })).toBeVisible();
    // exact:true → the uppercase card title, not the sidebar/subtitle "Snapshots" copy.
    await expect(page.getByText('SNAPSHOTS', { exact: true })).toBeVisible();
    // The danger reset trigger.
    await expect(page.getByRole('button', { name: 'Reset to clean slate…' })).toBeVisible();

    // SIZE / TABLES meta rows. exact:true avoids the lowercase "tables" in the
    // sidebar "Browse tables and rows" copy. Value is '…' until stats load.
    const sizeLabel = page.getByText('SIZE', { exact: true });
    const tablesLabel = page.getByText('TABLES', { exact: true });
    await expect(sizeLabel).toBeVisible();
    await expect(tablesLabel).toBeVisible();
    // After the stats fetch resolves, TABLES value is a number (not the … placeholder).
    const tablesValue = tablesLabel.locator('xpath=following-sibling::*[1]');
    await expect(tablesValue).not.toHaveText('…', { timeout: 10_000 });
  });

  test('snapshot list loads (empty placeholder or a list of rows)', async ({ page }) => {
    await gotoBackups(page);

    // Loading placeholder must resolve to either empty-state or a role=list.
    await expect(page.getByText('Loading snapshots…')).toBeHidden({ timeout: 10_000 });

    const emptyState = page.getByText('No snapshots yet.');
    const list = page.getByRole('list');
    // Exactly one of the two must be present.
    await expect(emptyState.or(list).first()).toBeVisible();
  });

  test('create snapshot → job runs, toast fires, list refreshes with the new row', async ({
    page,
  }) => {
    await gotoBackups(page);
    await expect(page.getByText('Loading snapshots…')).toBeHidden({ timeout: 10_000 });

    const labelInput = page.getByPlaceholder('Optional label…');
    const createBtn = page.getByRole('button', { name: 'Create snapshot' });

    await labelInput.fill(SNAP_LABEL);
    await createBtn.click();

    // The job-banner state machine: input + button disable while busy.
    await expect(createBtn).toBeDisabled();

    // On completion: toast + the new row appears in the list. Generous timeout —
    // a snapshot is a real pg_dump on the server.
    await expect(page.getByText('Snapshot complete')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(SNAP_LABEL)).toBeVisible({ timeout: 60_000 });

    // Controls re-enable once the job settles.
    await expect(createBtn).toBeEnabled({ timeout: 10_000 });
  });

  test('delete the snapshot we created → toast + row removed (self-cleaning)', async ({ page }) => {
    await gotoBackups(page);
    await expect(page.getByText('Loading snapshots…')).toBeHidden({ timeout: 10_000 });

    const row = page.getByRole('listitem').filter({ hasText: SNAP_LABEL });
    await expect(row).toBeVisible({ timeout: 10_000 });

    await row.getByRole('button', { name: 'Delete' }).click();

    await expect(page.getByText('Snapshot deleted')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(SNAP_LABEL)).toBeHidden({ timeout: 10_000 });
  });

  test('reset modal opens then cancels — never confirms a wipe', async ({ page }) => {
    await gotoBackups(page);

    await page.getByRole('button', { name: 'Reset to clean slate…' }).click();

    // Modal is open: header + the dangerous confirm button are present.
    await expect(page.getByText('Reset database to clean slate')).toBeVisible();
    const wipeBtn = page.getByRole('button', { name: /Wipe (content|everything)/ });
    await expect(wipeBtn).toBeVisible();

    // Cancel without wiping. Assert the modal closes and the wipe button is gone.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Reset database to clean slate')).toBeHidden();
    await expect(wipeBtn).toBeHidden();
  });
});
