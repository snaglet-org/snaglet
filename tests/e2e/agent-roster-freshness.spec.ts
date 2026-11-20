import { test, expect, type Page } from '@playwright/test';
import { openApp, gotoAgents } from './helpers/nav';
import {
  createThread,
  deleteThread,
  listAgents,
  openNodeViaPalette,
  runPrefix,
} from './helpers/workspace';

/**
 * Agent create/delete visibility without restart, plus roster-consuming
 * surfaces.
 *
 * Agent creation and deletion now emit the `agent.updated` workspace event
 * with 'created'/'deleted' lifecycle markers, so every window's roster
 * refetches live. Pinned here:
 *
 *   1. an agent created via the API appears in the Agents sidebar roster
 *      without any navigation or reload (pure WS push), and disappears the
 *      same way after deletion;
 *   2. a thread's add-participant picker (StatusStrip "+ agent" →
 *      AddAgentModal) offers the just-created agent;
 *   3. the composer @-mention popover offers the just-created agent;
 *   4. edge: a backend 5xx on create surfaces an inline error in the
 *      New-agent modal instead of crashing the app;
 *   5. edge: rapid double-click on "+ agent" opens exactly one modal.
 */

const API = `http://localhost:${process.env.PORT || '4001'}/api`;

async function createAgentViaApi(name: string): Promise<string> {
  const res = await fetch(`${API}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, role: 'e2e roster probe' }),
  });
  if (!res.ok) throw new Error(`agent create failed: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { id?: string } };
  const id = body.data?.id;
  if (!id) throw new Error('agent create returned no id');
  return id;
}

async function deleteAgentViaApi(id: string | null): Promise<void> {
  if (!id) return;
  await fetch(`${API}/agents/${id}`, { method: 'DELETE' }).catch((err: unknown) =>
    console.warn('best-effort cleanup failed:', err)
  );
}

test.describe('agent roster — live create/delete visibility', () => {
  test('a created agent appears in the sidebar roster with NO navigation, and deletion removes it', async ({
    page,
  }) => {
    const name = runPrefix('roster-live');
    let agentId: string | null = null;
    try {
      await openApp(page);
      await gotoAgents(page);
      const row = page.getByRole('treeitem', { name: new RegExp(name) });
      await expect(row).toHaveCount(0);

      // Create out-of-band while the roster stays on screen: the
      // agent.updated {created} broadcast must land it — no clicks, no
      // reload, no view switch.
      agentId = await createAgentViaApi(name);
      await expect(row.first()).toBeVisible({ timeout: 15_000 });

      // Delete out-of-band: the {deleted} broadcast must remove it the same
      // way.
      await deleteAgentViaApi(agentId);
      agentId = null;
      await expect(row).toHaveCount(0, { timeout: 15_000 });
    } finally {
      await deleteAgentViaApi(agentId);
    }
  });

  test("a thread's add-participant picker offers a just-created agent", async ({ page }) => {
    const name = runPrefix('roster-picker');
    const threadTitle = `${name}-thread`;
    let agentId: string | null = null;
    let threadId: string | null = null;
    try {
      const thread = await createThread({ title: threadTitle });
      threadId = thread.id;

      await openApp(page);
      await openNodeViaPalette(page, threadTitle);

      // Create the agent after the thread pane is open — the picker fetches
      // the roster when the modal mounts, so no reload may be needed.
      agentId = await createAgentViaApi(name);

      await page.getByRole('button', { name: '+ agent', exact: true }).first().click();
      const modal = page.getByRole('dialog');
      await expect(modal).toBeVisible();
      const select = modal.locator('select');
      await expect(select.locator('option', { hasText: name })).toHaveCount(1, {
        timeout: 15_000,
      });
      await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(modal).toBeHidden();
    } finally {
      await deleteAgentViaApi(agentId);
      await deleteThread(threadId);
    }
  });

  test('the composer @-mention popover offers a just-created agent', async ({ page }) => {
    const name = runPrefix('roster-mention');
    const threadTitle = `${name}-thread`;
    let agentId: string | null = null;
    let threadId: string | null = null;
    try {
      // A thread with an existing seeded participant so the composer is live.
      const seeded = (await listAgents()).find((a) => a.id !== 'ghost');
      if (!seeded) {
        test.skip(true, 'no seeded agent available');
        return;
      }
      const thread = await createThread({ title: threadTitle, agentId: seeded.id });
      threadId = thread.id;

      await openApp(page);
      agentId = await createAgentViaApi(name);
      await openNodeViaPalette(page, threadTitle);

      const composer = page.locator('[aria-label="Message composer"]');
      await composer.waitFor({ state: 'visible', timeout: 20_000 });
      await expect(composer).toHaveAttribute('contenteditable', 'true', { timeout: 20_000 });
      await composer.click();

      const popover = page.locator('[aria-label="Mention suggestions"]');
      await page.keyboard.type('@');
      await expect(popover).toBeVisible({ timeout: 5_000 });
      // Type enough of the unique name for the roster hit to surface.
      for (const ch of name.slice(0, 16)) {
        await page.keyboard.type(ch);
        await page.waitForTimeout(80);
      }
      await expect(
        popover.getByRole('option', { name: new RegExp(name.slice(0, 16), 'i') }).first()
      ).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press('Escape');
    } finally {
      await deleteAgentViaApi(agentId);
      await deleteThread(threadId);
    }
  });

  test('edge: backend 5xx on create surfaces an inline error, app stays alive', async ({
    page,
  }) => {
    await openApp(page);
    await gotoAgents(page);

    await page.route('**/api/agents', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            success: false,
            error: { message: 'e2e simulated create outage' },
          }),
        });
        return;
      }
      await route.fallback();
    });

    await page.getByRole('button', { name: 'New agent', exact: true }).click();
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await modal.getByLabel(/^Name/).fill(runPrefix('never-created'));
    await modal.getByRole('button', { name: 'Create', exact: true }).click();

    // The failure surfaces inline; the modal stays open for a retry; the app
    // shell survives.
    await expect(modal.getByText(/e2e simulated create outage|Failed to create agent/)).toBeVisible(
      { timeout: 10_000 }
    );
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('tab').first()).toBeVisible();
    await page.unroute('**/api/agents');
  });

  test('edge: rapid double-click on "+ agent" opens exactly one picker modal', async ({ page }) => {
    const threadTitle = `${runPrefix('roster-dblclick')}-thread`;
    let threadId: string | null = null;
    try {
      const thread = await createThread({ title: threadTitle });
      threadId = thread.id;

      await openApp(page);
      await openNodeViaPalette(page, threadTitle);

      const addAgent = page.getByRole('button', { name: '+ agent', exact: true }).first();
      await addAgent.waitFor({ state: 'visible', timeout: 15_000 });
      // The second click of a double-click may land on the freshly-mounted
      // modal overlay and dismiss it — acceptable. What must never happen:
      // two stacked modals, or a wedged app.
      await addAgent.dblclick();
      await page.waitForTimeout(500);
      const dialogsAfterStorm = await page.getByRole('dialog').count();
      expect(dialogsAfterStorm).toBeLessThanOrEqual(1);

      if (dialogsAfterStorm === 1) {
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      }
      await expect(page.getByRole('dialog')).toHaveCount(0);

      // And a deliberate single click still opens exactly one picker.
      await addAgent.click();
      await expect(page.getByRole('dialog')).toHaveCount(1, { timeout: 10_000 });
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } finally {
      await deleteThread(threadId);
    }
  });
});
