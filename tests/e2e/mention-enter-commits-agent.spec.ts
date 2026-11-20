import { test, expect } from '@playwright/test';
import { createChatWithAgent, getAgents } from './helpers/chat';

/**
 * Coverage-hunt spec for the user-reported mention-autocomplete requirement:
 *
 *   "When I @mention and the suggestion popover is open, typing an agent's
 *    exact name and pressing Enter should commit that agent's chip — never a
 *    stray doc/node hit that happened to be highlighted. But if I keep typing
 *    past the exact name, suggestions must keep flowing (popover stays live)."
 *
 * This is the two-part guarantee behind the `exactAgentHit` rule in
 * NodeMentionSearch.tsx (Enter commits `exactAgentHit ?? results[selectedIndex]`):
 *   - exact name + Enter => that agent's chip, regardless of highlight.
 *   - keep typing        => popover stays open and results keep updating.
 *
 * Drives the real composer (ChipEditableInput) + popover
 * ([aria-label="Mention suggestions"], rows are role="option").
 */

// A rendered mention chip — match the actual DOM the composer produces.
// The chip node renders as <span class="md-chip" data-node-kind="agent" ...>.
const CHIP_SELECTOR = 'span.md-chip[data-node-kind="agent"]';

const POPOVER = '[aria-label="Mention suggestions"]';

test.describe('@mention — Enter commits the exact agent, typing keeps suggesting', () => {
  test("typing an agent's exact name + Enter inserts THAT agent's chip", async ({ page }) => {
    const agents = await getAgents();
    if (agents.length === 0) {
      test.skip(true, 'No agents available');
      return;
    }
    const agent = agents[0];
    const { composer } = await createChatWithAgent(page, agent.name);

    await composer.click();

    const popover = page.locator(POPOVER);

    // Type the mention one char at a time so the live query registers (typing
    // the whole string at once can outrun the popover's query state). After the
    // full exact name is typed, the popover must be open and the agent must be
    // an offered option — i.e. exactAgentHit is resolvable.
    await page.keyboard.type('@');
    await expect(popover).toBeVisible({ timeout: 5_000 });
    for (const ch of agent.name) {
      await page.keyboard.type(ch);
      await page.waitForTimeout(120);
    }

    // Popover open with the agent present as an option right before Enter.
    await expect(popover).toBeVisible();
    await expect(
      popover.getByRole('option', { name: new RegExp(agent.name, 'i') }).first()
    ).toBeVisible({ timeout: 5_000 });

    // Commit with Enter — must land on the agent chip, not a stray hit.
    await page.keyboard.press('Enter');

    const chip = composer.locator(CHIP_SELECTOR).filter({ hasText: new RegExp(agent.name, 'i') });
    await expect(chip.first()).toBeVisible({ timeout: 5_000 });

    // The raw "@name" literal must not survive in the editor.
    const raw = await composer.innerText();
    expect(raw).not.toContain(`@${agent.name}`);
  });

  test('continuing to type past a prefix keeps the suggestion popover live', async ({ page }) => {
    const agents = await getAgents();
    if (agents.length === 0) {
      test.skip(true, 'No agents available');
      return;
    }
    const agent = agents[0];
    const { composer } = await createChatWithAgent(page, agent.name);

    await composer.click();

    const popover = page.locator(POPOVER);

    // Type one char at a time across a prefix of the agent name; the popover
    // must stay open and keep offering options as the query grows — it must
    // not lock or close after the first keystroke.
    const prefix = agent.name.slice(0, Math.min(3, agent.name.length));
    await page.keyboard.type('@');
    await expect(popover).toBeVisible({ timeout: 5_000 });

    for (const ch of prefix) {
      await page.keyboard.type(ch);
      // Popover stays open after every keystroke.
      await expect(popover).toBeVisible();
      // And keeps offering at least one option.
      await expect(popover.getByRole('option').first()).toBeVisible({ timeout: 5_000 });
    }

    // The matching agent is still an offered option after typing the prefix —
    // suggestions are not clouded out / closed by the exact-match logic.
    const agentOption = popover.getByRole('option', { name: new RegExp(agent.name, 'i') }).first();
    await expect(agentOption).toBeVisible({ timeout: 5_000 });
  });
});
