import { expect, type Locator, type Page } from '@playwright/test';
import { openNodeViaPalette } from './workspace';

export const API = `http://localhost:${process.env.PORT || '4001'}/api`;

export interface E2EAgent {
  id: string;
  name: string;
  provider?: string;
  credentialId?: string | null;
}

export async function getAgents(): Promise<E2EAgent[]> {
  const res = await fetch(`${API}/agents`);
  const body = await res.json();
  return body.data ?? [];
}

/**
 * The chat composer: a TipTap contenteditable (ChipEditableInput) exposing
 * role="textbox" + aria-label="Message composer". It is not a <textarea> and
 * has no `placeholder` attribute, so never select it by tag or placeholder.
 * `fill()` works on it (Playwright fills contenteditables); use
 * `pressSequentially()` / `page.keyboard.type()` when a test needs the typed
 * keystrokes themselves (mention autocomplete, Shift+Enter).
 */
function messageComposer(page: Page): Locator {
  return page.getByRole('textbox', { name: 'Message composer' });
}

/**
 * The composer's run-level Stop button. It renders only while any agent in
 * the thread is working (useChatStream `working`), so "no Stop button" is the
 * live signal that every agent has finished. `exact` keeps it from matching
 * the per-agent "Stop <name> run" buttons in AgentStatusBubbles.
 */
function composerStopButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Stop', exact: true });
}

/**
 * Wait for agents to reply: at least one agent bubble has rendered (so a run
 * actually started) and then no agent is still working.
 */
export async function waitForAgentsIdle(page: Page, timeout: number): Promise<void> {
  await page.locator('[class*="agentBubble"]').first().waitFor({ state: 'visible', timeout });
  await expect(composerStopButton(page)).toHaveCount(0, { timeout });
}

export async function createChatWithAgent(page: Page, agentName: string, ts?: number) {
  return createChatWithAgents(page, [agentName], ts);
}

/**
 * Create a thread with one or more agents (the first name leads the title)
 * and open it. Each agent is searched and ticked in the picker in turn; the
 * picker keeps earlier selections when the search text changes.
 */
async function createChatWithAgents(page: Page, agentNames: readonly string[], ts?: number) {
  if (agentNames.length === 0) throw new Error('createChatWithAgents needs at least one agent');
  // Drives the real thread-creation flow (WorkspaceTree + ThreadAgentPickerModal),
  // using the modal's aria contract.
  await page.goto('/');

  const newBtn = page.locator('[aria-label="Create at root"]');
  await newBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await newBtn.click();

  // The "+" opens a create menu (Container/Doc/Thread/Project).
  // Choosing "Thread" inserts an inline draft row (no modal) — type the name + Enter.
  const threadItem = page.getByRole('menuitem', { name: 'Thread', exact: true });
  await threadItem.waitFor({ state: 'visible', timeout: 10_000 });
  await threadItem.click();

  const threadName = `e2e ${agentNames.join(' + ')} ${ts ?? Date.now()}`;
  const draft = page.locator('input[aria-label="thread name"]');
  await draft.waitFor({ state: 'visible', timeout: 10_000 });
  await draft.fill(threadName);
  await draft.press('Enter');

  // Naming the thread opens the "Add agents to thread" modal (ThreadAgentPickerModal).
  // Search each agent, tick their row, then click "Create thread" (disabled until selected).
  const search = page.locator('input[placeholder="Search agents..."]');
  await search.waitFor({ state: 'visible', timeout: 10_000 });
  await expect(search).toBeEnabled({ timeout: 10_000 });
  for (const agentName of agentNames) {
    await search.fill(agentName);
    const agentRow = page.getByRole('option', { name: new RegExp(agentName, 'i') }).first();
    await agentRow.waitFor({ state: 'visible', timeout: 10_000 });
    await agentRow.click();
    await expect(agentRow).toHaveAttribute('aria-selected', 'true');
  }

  const createBtn = page.getByRole('button', { name: /Create thread/i });
  await expect(createBtn).toBeEnabled({ timeout: 10_000 });
  await createBtn.click();

  // The modal's `onCreate` handler awaits the create API call before it
  // unmounts (ThreadAgentPickerModal.tsx `submit()` -> `setPendingThread(null)`
  // only runs after `onCreate` resolves) — wait for it to close so the create
  // has actually landed server-side before we go looking for the thread.
  // While the create call is in flight, the modal's own thread-name preview is
  // the only element matching the title, so a text locator would click that
  // inert div instead of the (not yet refetched) sidebar row.
  await search.waitFor({ state: 'hidden', timeout: 15_000 });

  // Open the freshly-created thread via the command palette instead of
  // clicking the sidebar tree row. The palette re-invalidates + refetches
  // the workspace tree on open (see `openNodeViaPalette` in
  // `./workspace.ts`), so it doesn't race the sidebar's own unsynchronized
  // refetch and there's no ambiguous DOM text match to land on.
  await openNodeViaPalette(page, threadName);

  // The composer is a contentEditable (ChipEditableInput/TipTap), not a <textarea>.
  // It is only editable once an onSubmit handler is wired (contenteditable flips to "true");
  // wait for that so callers don't race the read-only mount.
  const composer = messageComposer(page);
  await composer.waitFor({ state: 'visible', timeout: 40_000 });
  await expect(composer).toHaveAttribute('contenteditable', 'true', { timeout: 40_000 });
  // Return the exact thread title so callers can resolve this thread's id for
  // trace reads — never a stale prefix match against other "e2e Subject ..." threads.
  return { composer, threadName };
}

export async function createChatWithAgentMatching(
  page: Page,
  predicate: (agent: E2EAgent) => boolean
) {
  const agents = await getAgents();
  const agent = agents.find(predicate);
  if (!agent) return null;

  const { composer, threadName } = await createChatWithAgent(page, agent.name);
  // `textarea` aliases the composer Locator for specs that read `chat.textarea`.
  return { agent, composer, threadName, textarea: composer };
}
