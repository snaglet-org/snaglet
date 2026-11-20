import { test, expect } from '@playwright/test';
import { createChatWithAgentMatching } from './helpers/chat';

test.describe('Chat composer newlines', () => {
  test('Shift+Enter round-trips through draft reload, send, and rendered transcript without visible backslashes', async ({
    page,
  }) => {
    const chat = await createChatWithAgentMatching(page, (agent) => Boolean(agent.name));
    if (!chat) {
      test.skip(true, 'No agents available');
      return;
    }

    const { composer } = chat;
    await expect(composer).toBeEnabled({ timeout: 20_000 });

    await composer.click();
    await composer.pressSequentially('line one');
    await composer.press('Shift+Enter');
    await composer.pressSequentially('line two');

    await expect(composer).not.toContainText('\\');
    expect(await composer.locator('br').count()).toBeGreaterThan(0);

    // Composer draft persistence is debounced; wait for the draft write before
    // reloading so this assertion covers the real restore path, not a race.
    await page.waitForTimeout(500);

    await page.reload();

    const reloadedComposer = page.locator('[aria-label="Message composer"]');
    await reloadedComposer.waitFor({ state: 'visible', timeout: 40_000 });
    await expect(reloadedComposer).toHaveAttribute('contenteditable', 'true', { timeout: 40_000 });
    await expect(reloadedComposer).toContainText('line one');
    await expect(reloadedComposer).toContainText('line two');
    await expect(reloadedComposer).not.toContainText('\\');
    expect(await reloadedComposer.locator('br').count()).toBeGreaterThan(0);

    await page.locator('button[aria-label="Send message"]').click();

    const userBubble = page.locator('[data-tid="userBubble"]').last();
    await expect(userBubble).toBeVisible({ timeout: 10_000 });
    await expect(userBubble).toContainText('line one');
    await expect(userBubble).toContainText('line two');
    await expect(userBubble).not.toContainText('\\');
    expect(await userBubble.locator('br').count()).toBeGreaterThan(0);
  });
});
