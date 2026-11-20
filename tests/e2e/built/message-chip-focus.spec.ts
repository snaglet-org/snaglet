import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { BuiltWorkspace } from '../helpers/builtWorkspace';

/**
 * Opening a message chip (or a message search hit) lands on that exact
 * message, keeps it there while the thread's activity log loads and grows the
 * rows above it, and keeps it highlighted until the user scrolls.
 *
 * Runs in WebKit, the engine of the macOS desktop app. Chromium's scroll
 * anchoring hides the drift; WebKit has none, so this is where it shows.
 */

test.describe.configure({ mode: 'serial' });
test.use({ browserName: 'webkit' });

const MESSAGE_COUNT = 80;
/** An agent reply in the middle of the thread, outside the latest page. */
const TARGET_INDEX = 41;
/** An agent reply taller than the preview's message list. */
const TALL_INDEX = 45;
const TOOL_CALLS_PER_RUN = 4;
const SEARCH_TOKEN = 'quokkafocusmarker';

let workspace: BuiltWorkspace;
const messageIds: string[] = [];
const docTitle = `Message chip host ${Date.now().toString(36)}`;

async function api<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${workspace.apiUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} ${res.status}: ${text}`);
  return (JSON.parse(text) as { data: T }).data;
}

function agentReply(index: number): string {
  const lines = [
    `### Reply ${index}`,
    '',
    `Agent reply ${index}. Long enough to wrap over a couple of lines, like an ordinary answer.`,
    '',
    '- first point',
    '- second point',
  ];
  if (index === TARGET_INDEX) lines.push('', `Search marker: ${SEARCH_TOKEN}`);
  if (index === TALL_INDEX) {
    for (let line = 1; line <= 40; line++) lines.push('', `Tall reply line ${line}.`);
  }
  return lines.join('\n');
}

/**
 * A thread of alternating user messages and finished agent runs, each run with
 * a few logged tool calls, as a thread looks after real work. Runs and their
 * tool-call log have no public write API, so they are written directly.
 */
async function seedThread(): Promise<void> {
  const agent = await api<{ id: string }>('/agents', { name: 'Test Agent A' });
  const thread = await api<{ id: string }>('/threads', {
    title: 'Focus thread',
    agentId: agent.id,
  });
  const [user] = await workspace.query<{ id: string }>(
    'SELECT id FROM users ORDER BY created_at LIMIT 1'
  );

  const base = Date.now() - MESSAGE_COUNT * 60_000;
  const rows = Array.from({ length: MESSAGE_COUNT }, (_, index) => {
    const isAgent = index % 2 === 1;
    return {
      id: `message-${randomUUID()}`,
      userId: isAgent ? null : user.id,
      agentId: isAgent ? agent.id : null,
      role: isAgent ? 'assistant' : 'user',
      content: isAgent ? agentReply(index) : `User message ${index}. Please do the next step.`,
      runId: isAgent ? randomUUID() : null,
      at: new Date(base + index * 60_000).toISOString(),
    };
  });
  messageIds.push(...rows.map((row) => row.id));
  const runs = rows.filter((row) => row.runId !== null);

  await workspace.query(`INSERT INTO nodes (id, type) SELECT unnest($1::text[]), 'message'`, [
    rows.map((row) => row.id),
  ]);
  await workspace.query(
    `INSERT INTO runs (id, thread_id, agent_id, provider_id, model, status, started_at, finished_at)
     SELECT run_id, $2, $3, 'anthropic', 'test-model', 'completed', at, at
       FROM unnest($1::text[], $4::timestamptz[]) AS t(run_id, at)`,
    [runs.map((row) => row.runId), thread.id, agent.id, runs.map((row) => row.at)]
  );
  await workspace.query(
    `INSERT INTO agent_activity_log
       (agent_id, run_id, action_type, trigger_type, tool, tool_input, tool_output, duration_ms, created_at)
     SELECT $1, run_id, 'tool_call', 'message_received', 'snaglet_search',
            jsonb_build_object('query', 'step ' || step),
            jsonb_build_object('output', 'result ' || step), 120, at
       FROM unnest($2::text[], $3::timestamptz[]) AS t(run_id, at),
            generate_series(1, $4::int) AS step`,
    [agent.id, runs.map((row) => row.runId), runs.map((row) => row.at), TOOL_CALLS_PER_RUN]
  );
  await workspace.query(
    `INSERT INTO messages (id, thread_id, user_id, agent_id, role, content, run_id, created_at)
     SELECT id, $2, user_id, agent_id, role, content, run_id, at
       FROM unnest($1::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::timestamptz[])
         AS t(id, user_id, agent_id, role, content, run_id, at)`,
    [
      rows.map((row) => row.id),
      thread.id,
      rows.map((row) => row.userId),
      rows.map((row) => row.agentId),
      rows.map((row) => row.role),
      rows.map((row) => row.content),
      rows.map((row) => row.runId),
      rows.map((row) => row.at),
    ]
  );

  await api('/docs', {
    title: docTitle,
    content: [
      `# ${docTitle}`,
      '',
      `Linked reply: [Reply ${TARGET_INDEX}](message:${messageIds[TARGET_INDEX]})`,
      '',
      `Tall reply: [Reply ${TALL_INDEX}](message:${messageIds[TALL_INDEX]})`,
      '',
    ].join('\n'),
  });
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  workspace = await BuiltWorkspace.boot();
  await seedThread();
});

test.afterAll(async () => {
  await workspace?.dispose();
});

async function quickSearch(page: Page, query: string, option: string | RegExp): Promise<void> {
  await page.getByRole('tab').first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  const dialog = page.getByRole('dialog', { name: 'Quick search' });
  await expect(dialog).toBeVisible();
  await page.getByRole('textbox', { name: 'Quick search' }).fill(query);
  await dialog.getByRole('option', { name: option }).first().click();
  await expect(dialog).toBeHidden();
}

/**
 * Holds the thread's activity-log response until its messages have landed.
 * The two are fetched in parallel; on a real thread the log usually comes
 * second, and that order is what moved the message, so the spec pins it.
 */
async function deliverActivityLogLast(page: Page): Promise<void> {
  const messagesLanded = page
    .waitForResponse((res) => res.url().includes('/messages?around='), { timeout: 30_000 })
    .then(
      () => page.waitForTimeout(300),
      () => undefined
    );
  await page.route('**/activity-log**', async (route) => {
    await messagesLanded;
    await route.continue();
  });
}

/** scrollTop once it has stopped changing. */
async function settledScrollTop(list: Locator): Promise<number> {
  let last = Number.NaN;
  await expect
    .poll(
      async () => {
        const now = await list.evaluate((el) => el.scrollTop);
        const settled = Math.abs(now - last) <= 1;
        last = now;
        return settled;
      },
      { intervals: [100] }
    )
    .toBe(true);
  return last;
}

async function openChipPreview(page: Page, index: number): Promise<Locator> {
  await deliverActivityLogLast(page);
  await page.goto(workspace.baseUrl);
  await quickSearch(page, docTitle, docTitle);
  const chip = page.locator(`[data-node-url="message:${messageIds[index]}"]`).first();
  await chip.locator('.md-chip-title').click();
  const modal = page.getByTestId('wiki-link-preview');
  await expect(modal).toBeVisible();
  return modal.getByTestId('message-list');
}

/** Waits until every run's tool calls have rendered in the list. */
async function waitForActivity(list: Locator): Promise<void> {
  await expect
    .poll(() => list.getByText(`${TOOL_CALLS_PER_RUN} tool calls`).count(), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(MESSAGE_COUNT / 2);
}

/** The target's box relative to the list's visible area. */
async function placement(list: Locator, index: number) {
  return list.evaluate((el, id) => {
    const target = el.querySelector(`[data-message-id="${id}"]`);
    if (!target) return null;
    const view = el.getBoundingClientRect();
    const row = target.getBoundingClientRect();
    const atCenter = document
      .elementFromPoint(view.left + view.width / 2, view.top + view.height / 2)
      ?.closest('[data-message-id]')
      ?.getAttribute('data-message-id');
    return {
      top: row.top - view.top,
      bottom: row.bottom - view.top,
      height: row.height,
      viewHeight: el.clientHeight,
      centerIsTarget: atCenter === id,
    };
  }, messageIds[index]);
}

function highlighted(list: Locator, index: number): Locator {
  return list.locator(`[data-focus-highlight="true"] [data-message-id="${messageIds[index]}"]`);
}

async function expectLandedAndHeld(list: Locator, index: number): Promise<void> {
  await waitForActivity(list);
  await expect.poll(() => placement(list, index)).toMatchObject({ centerIsTarget: true });
  const box = await placement(list, index);
  expect(box).not.toBeNull();
  expect(box!.top).toBeGreaterThanOrEqual(0);
  expect(box!.bottom).toBeLessThanOrEqual(box!.viewHeight + 1);
  await expect(highlighted(list, index)).toHaveCount(1);
  // Seconds later it is still in place and still marked.
  await list.page().waitForTimeout(2_000);
  await expect.poll(() => placement(list, index)).toMatchObject({ centerIsTarget: true });
  await expect(highlighted(list, index)).toHaveCount(1);
}

test('a message chip opens on that message and keeps it in view and highlighted', async ({
  page,
}) => {
  const list = await openChipPreview(page, TARGET_INDEX);
  await expectLandedAndHeld(list, TARGET_INDEX);

  // The user scrolling takes over: the highlight clears and the view stays
  // where they put it.
  await list.hover();
  await page.mouse.wheel(0, -600);
  await expect(highlighted(list, TARGET_INDEX)).toHaveCount(0);
  await expect.poll(() => placement(list, TARGET_INDEX)).toMatchObject({ centerIsTarget: false });
  const scrolledTo = await settledScrollTop(list);
  await page.waitForTimeout(500);
  expect(Math.abs((await list.evaluate((el) => el.scrollTop)) - scrolledTo)).toBeLessThanOrEqual(1);
});

test('a message taller than the view opens at its top', async ({ page }) => {
  const list = await openChipPreview(page, TALL_INDEX);
  await waitForActivity(list);
  await expect.poll(async () => (await placement(list, TALL_INDEX))?.top).toBeGreaterThanOrEqual(0);
  const box = await placement(list, TALL_INDEX);
  expect(box!.height).toBeGreaterThan(box!.viewHeight);
  expect(box!.top).toBeLessThanOrEqual(24);
  await expect(highlighted(list, TALL_INDEX)).toHaveCount(1);
});

test('a message search hit opens the thread on that message, held and highlighted', async ({
  page,
}) => {
  await deliverActivityLogLast(page);
  await page.goto(workspace.baseUrl);
  await quickSearch(page, SEARCH_TOKEN, /Reply 41/);
  const list = page.getByTestId('message-list');
  await expect(list).toBeVisible();
  await expectLandedAndHeld(list, TARGET_INDEX);
});
