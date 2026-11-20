import { test, expect } from '@playwright/test';
import { openApp } from './helpers/nav';
import {
  createThread,
  addThreadParticipant,
  deleteThread,
  listAgents,
  openNodeViaPalette,
  runPrefix,
} from './helpers/workspace';

/**
 * Thread events: machine state-change narration rows (roster / dispatch-mode /
 * "thread started") are persisted with role='user' but are not something the
 * human typed. They must render as a centered meta line (data-tid=threadEventRow),
 * never as the user's chat bubble (data-tid=userBubble). This spec asserts that
 * data-tid/role distinction — never styling.
 */
test.describe('Thread events — meta row vs user bubble', () => {
  const prefix = runPrefix('threadevents');

  // Core, deterministic, zero-LLM guard
  // A `participant_added` event is persisted the instant a roster member is
  // added (no model dispatch), so we can assert the meta-vs-bubble distinction
  // without any provider call.
  test.describe('participant_added event', () => {
    let threadId: string | null = null;

    test.afterAll(async () => {
      await deleteThread(threadId);
    });

    test('a thread_event renders as a centered meta row, not a user bubble', async ({ page }) => {
      const agents = await listAgents();
      expect(agents.length, 'workspace has at least one agent to add').toBeGreaterThan(0);

      const { id } = await createThread({ title: `${prefix}-participant`, projectId: null });
      threadId = id;
      // Adding a participant persists a `[participant added · …]` thread_event.
      await addThreadParticipant(id, agents[0].id);

      await openApp(page);
      await openNodeViaPalette(page, `${prefix}-participant`);

      // The event renders as a threadEventRow (meta), carrying its narration text.
      const eventRow = page.locator('[data-tid="threadEventRow"]');
      await expect(eventRow.first()).toBeVisible({ timeout: 15_000 });
      await expect(eventRow.first()).toContainText(/participant added/i);

      // Critically: it is not rendered as the user's own bubble — no user
      // message was sent, so there must be zero user bubbles.
      await expect(page.locator('[data-tid="userBubble"]')).toHaveCount(0);
    });
  });

  // thread_started + user bubble (real dispatch)
  // The `[thread started …]` narration is only emitted once the thread first
  // dispatches, which requires a real agent/model call. Gated behind
  // E2E_RUN_LLM so routine runs don't spend tokens (honors the cheap-model
  // preference); the assertions do not wait for the agent's reply.
  test.describe('thread_started event (real send)', () => {
    test.skip(!process.env.E2E_RUN_LLM, 'set E2E_RUN_LLM=1 to run the real-dispatch send');

    let threadId: string | null = null;

    test.afterAll(async () => {
      // Delete the thread (also aborts any in-flight run).
      await deleteThread(threadId);
    });

    test('user message renders as a bubble; the thread-started narration as a meta row', async ({
      page,
    }) => {
      // Pick the cheapest dispatchable anthropic agent (avoid opus) to keep the
      // real dispatch inexpensive.
      const agents = await listAgents();
      const anthropic = agents.filter((a) => a.provider === 'anthropic');
      const pick =
        anthropic.find((a) => /haiku/i.test(a.modelId ?? '')) ??
        anthropic.find((a) => /sonnet/i.test(a.modelId ?? '')) ??
        anthropic[0];
      expect(pick, 'a dispatchable anthropic agent must exist').toBeTruthy();

      // Create the thread with the agent already in the roster via the API, then
      // open it in the pane — avoids the flaky multi-step UI creation flow.
      const title = `${prefix}-started`;
      const { id } = await createThread({ title, projectId: null, agentId: pick.id });
      threadId = id;

      await openApp(page);
      await openNodeViaPalette(page, title);

      // The chat composer must be mounted + editable before we type.
      const composer = page.locator('[aria-label="Message composer"]');
      await expect(composer).toBeVisible({ timeout: 30_000 });
      await expect(composer).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });

      const text = `${prefix} hello`;
      await composer.click();
      await composer.fill(text);
      await page.locator('button[aria-label="Send message"]').click();

      // The user's own message is a bubble carrying the typed text.
      const userBubble = page.locator('[data-tid="userBubble"]').filter({ hasText: text });
      await expect(userBubble.first()).toBeVisible({ timeout: 20_000 });

      // The thread-started narration is a centered meta row (emitted at dispatch
      // start — we don't wait for the reply), not a user bubble.
      const eventRow = page.locator('[data-tid="threadEventRow"]');
      await expect(eventRow.first()).toBeVisible({ timeout: 30_000 });
      await expect(eventRow.first()).toContainText(/thread started/i);
      // The narration text must not have leaked into a user bubble.
      await expect(
        page.locator('[data-tid="userBubble"]').filter({ hasText: /thread started/i })
      ).toHaveCount(0);
    });
  });
});
