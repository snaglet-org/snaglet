import { test, expect } from '@playwright/test';
import { createChatWithAgent, getAgents } from './helpers/chat';

/**
 * Mention search supports file/folder filters and keeps spaces inside the
 * query. Run against the chat composer: that's where mention search is
 * actually wired in. Doc editor has no mention plugin.
 *
 * `.fill()` does not exercise the mention extension because it sets the
 * editor content directly without firing the per-keystroke events Tiptap
 * needs. Real `keyboard.type` is required.
 */
test('mention search keeps spaces and supports file/folder filters', async ({ page }) => {
  const agents = await getAgents();
  if (agents.length === 0) {
    test.skip(true, 'No agents available to seed a chat fixture.');
    return;
  }
  const agent = agents[0];
  const { composer } = await createChatWithAgent(page, agent.name);
  await expect(composer).toBeVisible();

  const popup = page.getByRole('listbox', { name: 'Mention suggestions' });

  // file:<query with spaces>
  await composer.click();
  await page.keyboard.type('@file:palette search');
  await expect(popup, '@file: query with space surfaces the popup').toBeVisible();

  // Reset composer between queries by selecting all and deleting.
  await composer.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');

  // folder:<query with space>
  await composer.click();
  await page.keyboard.type('@folder:src comp');
  await expect(popup, '@folder: query with space surfaces the popup').toBeVisible();
});
