import { test, expect } from '@playwright/test';
import { createChatWithAgent, getAgents } from './helpers/chat';

/**
 * Typing @name for an agent in the thread turns it into that agent's node
 * chip, every time.
 *
 * This drives the real composer (ChipEditableInput) via the proven
 * createChatWithAgent helper, types an @mention, and asserts the typed
 * text converts into an agent chip node. A mention chip is rendered as a
 * contentEditable child with data-mention / data-node-chip attributes
 * (not plain "@name" text left in the editor).
 *
 * The composer is [aria-label="Message composer"]. A converted chip is a
 * non-editable inline node; the raw "@name " literal must not survive.
 */

// A rendered mention chip — match the actual DOM the composer produces.
const CHIP_SELECTOR =
  '[data-mention], [data-node-chip], [data-chip], span[contenteditable="false"], .mention-chip';

test.describe('@mention → agent chip conversion', () => {
  test('typing @<agent> + space converts to an agent chip', async ({ page }) => {
    const agents = await getAgents();
    if (agents.length === 0) {
      test.skip(true, 'No agents available');
      return;
    }
    const agent = agents[0];
    const { composer } = await createChatWithAgent(page, agent.name);

    await composer.click();
    // Type the mention then a trailing space — the documented trigger to
    // commit a typed @handle into a chip.
    await page.keyboard.type(`@${agent.name} `);

    // The chip should appear in the composer.
    const chip = composer.locator(CHIP_SELECTOR).filter({ hasText: new RegExp(agent.name, 'i') });
    await expect(chip.first()).toBeVisible({ timeout: 5_000 });

    // And the raw "@name" literal text should not remain in the editor.
    const raw = await composer.innerText();
    expect(raw).not.toContain(`@${agent.name}`);
  });

  test('selecting an agent from the mention popup inserts a chip', async ({ page }) => {
    const agents = await getAgents();
    if (agents.length === 0) {
      test.skip(true, 'No agents available');
      return;
    }
    const agent = agents[0];
    const { composer } = await createChatWithAgent(page, agent.name);

    await composer.click();
    // Type just "@" + a prefix to open the suggestion popup, then pick the agent.
    await page.keyboard.type(`@${agent.name.slice(0, 2)}`);

    const option = page.getByRole('option', { name: new RegExp(agent.name, 'i') }).first();
    await option.waitFor({ state: 'visible', timeout: 5_000 });
    await option.click();

    const chip = composer.locator(CHIP_SELECTOR).filter({ hasText: new RegExp(agent.name, 'i') });
    await expect(chip.first()).toBeVisible({ timeout: 5_000 });
  });
});
