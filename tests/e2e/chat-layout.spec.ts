import { test, expect } from '@playwright/test';
import { createChatWithAgentMatching } from './helpers/chat';

test.describe('Chat layout', () => {
  test('renders user messages on the right side', async ({ page }) => {
    const chat = await createChatWithAgentMatching(page, (agent) => Boolean(agent.name));
    if (!chat) {
      test.skip(true, 'No agents available');
      return;
    }

    const { textarea } = chat;
    await expect(textarea).toBeEnabled({ timeout: 20_000 });

    await textarea.click();
    await textarea.pressSequentially('layout position check');
    await page.locator('button[aria-label="Send message"]').click();

    const messagesContainer = page.getByTestId('message-list');
    const userBubble = page.locator('[class*="userBubble"]').last();

    await expect(userBubble).toBeVisible({ timeout: 10_000 });

    const containerBox = await messagesContainer.boundingBox();
    const userBox = await userBubble.boundingBox();

    expect(containerBox).not.toBeNull();
    expect(userBox).not.toBeNull();
    if (!containerBox || !userBox) return;

    const containerCenterX = containerBox.x + containerBox.width / 2;
    const userCenterX = userBox.x + userBox.width / 2;
    expect(userCenterX).toBeGreaterThan(containerCenterX);

    const leftGap = userBox.x - containerBox.x;
    const rightGap = containerBox.x + containerBox.width - (userBox.x + userBox.width);
    expect(rightGap).toBeLessThan(leftGap);
  });
});
