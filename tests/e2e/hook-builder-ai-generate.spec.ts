import { expect, test, type Page } from '@playwright/test';

/**
 * Hook builder — agent handoff.
 *
 * The hook builder has no inline "AI assist" strip (type a prompt → Generate →
 * code lands in the editor). BuilderAgentHandoff moves authoring into a
 * thread instead: Snaglet opens a thread with a modeled agent and puts the
 * request in its composer (prepared, not sent), so the agent's
 * hook(op:create) / file_edit calls happen where their tool activity is
 * visible.
 *
 * This spec pins that contract without dispatching any LLM turn (nothing is
 * sent — the user sends when it reads right):
 *   1. The handoff strip renders in the hook builder's code section, and the
 *      "Prepare in a thread" action is gated on a non-empty request.
 *   2. Preparing opens/creates a thread whose composer carries the request
 *      text as an unsent draft.
 */

async function openHookBuilder(page: Page) {
  await page.goto('/');
  await page.getByRole('tab', { name: /^Automations\b/ }).click();
  await page.getByRole('button', { name: 'New automation or script', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New script', exact: true }).click();
  // The New-hook panel surfaces the code editor directly; a Code tab exists
  // only in the multi-tab builder layout. Click it when present.
  const codeTab = page.getByRole('tab', { name: 'Code', exact: true });
  if (await codeTab.isVisible().catch(() => false)) await codeTab.click();
  const editor = page.getByRole('textbox', { name: 'hook.ts observer code' });
  await expect(editor).toBeVisible({ timeout: 15_000 });
  return editor;
}

const HOOK_PLACEHOLDER = 'e.g. when a task moves to Done, post a summary in the team thread';

test.describe('hook builder agent handoff', () => {
  test('handoff strip renders and Prepare is gated on a non-empty request', async ({ page }) => {
    await openHookBuilder(page);

    // The strip's contract copy — prepared, not sent.
    await expect(page.getByText(/Describe what this hook should do/)).toBeVisible();
    await expect(page.getByText(/prepared, not sent/i)).toBeVisible();

    const request = page.getByPlaceholder(HOOK_PLACEHOLDER);
    await expect(request).toBeVisible();

    const prepare = page.getByRole('button', { name: /Prepare in a thread/ });
    await expect(prepare).toBeVisible();
    // Empty request → gated off, regardless of capability state.
    await expect(prepare).toBeDisabled();
  });

  test('preparing puts the request into a thread composer as an unsent draft', async ({ page }) => {
    await openHookBuilder(page);

    const requestText = `e2e handoff probe ${Date.now().toString(36)}: when a doc is archived, log it`;
    await page.getByPlaceholder(HOOK_PLACEHOLDER).fill(requestText);

    const prepare = page.getByRole('button', { name: /Prepare in a thread/ });
    // The capability probe (can this agent hook(op:create) / file_edit?) must
    // resolve before Prepare enables. If no agent on this workspace can write
    // a hook, the strip says so — that is a legitimate configuration, not a
    // failure of the handoff surface.
    const notReady = page.getByText(/cannot write a hook right now/);
    await expect(prepare.or(notReady).first()).toBeVisible({ timeout: 15_000 });
    if (await notReady.isVisible().catch(() => false)) {
      test.skip(true, 'no modeled agent with hook-writing tools on this workspace');
      return;
    }
    await expect(prepare).toBeEnabled({ timeout: 15_000 });
    await prepare.click();

    // Prepared, not sent — the confirmation names the agent and offers to
    // open the thread.
    await expect(page.getByText(/Prepared in a thread with/)).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Open thread', exact: true }).click();

    // The thread composer carries the request as an unsent draft.
    const composer = page.locator('[aria-label="Message composer"]');
    await composer.waitFor({ state: 'visible', timeout: 20_000 });
    await expect(composer).toContainText(requestText.slice(0, 40), { timeout: 20_000 });

    // Nothing was dispatched: the request text must not appear as a sent
    // message row (only in the composer draft).
    const sentRow = page
      .locator('[class*="message"], [data-message-id]')
      .filter({ hasText: requestText.slice(0, 40) });
    await expect(sentRow).toHaveCount(0);
  });
});
