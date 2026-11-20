import { test, expect } from '@playwright/test';
import { openApp, gotoView } from './helpers/nav';
import { listMcpKeys, revokeMcpKey, runPrefix } from './helpers/workspace';

/**
 * MCP client connections: create a client connection from the MCP sidebar, see the one-time key revealed in the connection pane, then
 * revoke the connection and watch the row disappear.
 *
 * Cleanup note: revoke hard-deletes the key row (there is no soft-revoke
 * state). afterAll ensures the key is revoked/gone and relies on a unique
 * per-run key name so residual rows never collide.
 */
test.describe('MCP client connections — create + reveal + revoke', () => {
  const keyName = runPrefix('mcp');

  test.afterAll(async () => {
    const mine = (await listMcpKeys()).find((k) => k.name === keyName);
    if (mine) await revokeMcpKey(mine.id);
  });

  test('create shows a one-time key, lists the connection, and revoke deletes it', async ({
    page,
  }) => {
    await openApp(page);
    await gotoView(page, 'MCP');

    // Client connections group → "+" opens the inline create row. exact:true —
    // the group header's accessible name also contains the + button's label.
    await page.getByRole('button', { name: 'Create MCP client connection', exact: true }).click();
    const nameInput = page.getByLabel('New MCP client name');
    await expect(nameInput).toBeVisible();
    await nameInput.fill(keyName);
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    // The new connection appears in the sidebar tree (TreeRow renders as a
    // button whose accessible name is "<name> new|used").
    const row = page.getByRole('button', { name: new RegExp(keyName) });
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Open the connection pane — the freshly minted key is revealed exactly
    // once, with the copy-now notice.
    await row.click();
    await expect(
      page.getByText('Copy this key now. Snaglet stores only its hash and cannot show it again.')
    ).toBeVisible({ timeout: 10_000 });
    const token = (
      await page
        .locator('code')
        .filter({ hasText: /^snaglet_|^[A-Za-z0-9_-]{20,}$/ })
        .first()
        .innerText()
    ).trim();
    expect(token.length).toBeGreaterThan(0);

    // The key exists at the API level too.
    await expect
      .poll(async () => (await listMcpKeys()).some((k) => k.name === keyName), {
        timeout: 10_000,
      })
      .toBe(true);

    // Revoke → confirmation → the row is deleted and disappears. The
    // confirmation is either a native confirm() or an in-DOM Modal with its
    // own "Revoke" button; accept whichever appears.
    // `on` (not `once`) so a retried revoke can be confirmed again.
    page.on('dialog', (dialog) => void dialog.accept());
    const revoke = page.getByRole('button', { name: 'Revoke connection' });
    const confirmRevoke = async () => {
      await revoke.click();
      const modal = page.getByRole('dialog', { name: /Revoke the MCP client connection/ });
      // Give an in-DOM modal a moment to mount; absence within the window
      // means the native confirm() path already resolved via the handler.
      await modal.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {
        console.warn('mcp-keys: revoke modal did not mount within 2s — assuming pre-resolved');
      });
      if (await modal.isVisible().catch(() => false)) {
        await modal.getByRole('button', { name: 'Revoke', exact: true }).click();
      }
    };
    await confirmRevoke();
    // Server-side truth first: poll the API for deletion, retrying once if
    // the first attempt was swallowed by full-suite contention.
    const gone = async () => !(await listMcpKeys()).some((k) => k.name === keyName);
    try {
      await expect.poll(gone, { timeout: 7_000 }).toBe(true);
    } catch {
      if (await revoke.isVisible().catch(() => false)) await confirmRevoke();
      await expect.poll(gone, { timeout: 10_000 }).toBe(true);
    }
    // And the UI reflects it — the sidebar row disappears.
    await expect(row).toBeHidden({ timeout: 10_000 });
  });
});
