import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { openNodeViaPalette } from './helpers/workspace';

interface ApiEnvelope<T> {
  data: T;
}

interface ThreadRecord {
  id: string;
}

interface AgentRecord {
  id: string;
}

const API = `http://localhost:${process.env.PORT || '4001'}/api`;
const longCell = Array.from(
  { length: 90 },
  (_, index) => `expandable sentence ${index + 1} stays readable at the constrained column width`
).join(' ');

const markdown = `| Name | Branch | Builder | Status | Review | Notes |
| --- | --- | --- | --- | --- | --- |
| Short | fx-0-table-width | Venus | Active | Rex | ${longCell} |`;

async function createThread(request: APIRequestContext): Promise<{ id: string; title: string }> {
  const title = `e2e-markdown-table-${Date.now()}`;
  const agentsResponse = await request.get(`${API}/agents`);
  expect(agentsResponse.ok()).toBeTruthy();
  const agentsBody = (await agentsResponse.json()) as ApiEnvelope<AgentRecord[]>;
  const agents = agentsBody.data.slice(0, 2);
  expect(
    agents,
    'markdown table E2E requires the two agents seeded by the normal dev bootstrap'
  ).toHaveLength(2);

  const response = await request.post(`${API}/threads`, {
    data: { title, agentId: agents[0]?.id },
  });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as ApiEnvelope<ThreadRecord>;
  const threadId = body.data.id;

  try {
    // A group thread in mentioned-only mode persists an unmentioned fixture
    // message without dispatching either real agent. This exercises the sent
    // message renderer without creating a run that can race teardown.
    const participantResponse = await request.post(`${API}/threads/${threadId}/participants`, {
      data: { agentId: agents[1]?.id },
    });
    expect(participantResponse.ok()).toBeTruthy();
    const modeResponse = await request.patch(`${API}/threads/${threadId}`, {
      data: { dispatch_mode: 'mentioned' },
    });
    expect(modeResponse.ok()).toBeTruthy();
    return { id: threadId, title };
  } catch (error) {
    const cleanupResponse = await request.delete(`${API}/threads/${threadId}`);
    expect(cleanupResponse.ok()).toBeTruthy();
    throw error;
  }
}

async function openTable(page: Page, threadTitle: string): Promise<Locator> {
  await page.goto('/');
  await openNodeViaPalette(page, threadTitle);

  const composer = page.getByLabel('Message composer');
  await expect(composer).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
  await composer.click();
  await composer.evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
    );
  }, markdown);
  // Enter edits the draft while the caret is inside a structured table.
  // Submit through the explicit user action so the table is rendered in the
  // sent-message reader rather than measured in the editor.
  await page.getByRole('button', { name: 'Send message' }).click();

  const table = page.locator('[data-tid="userRow"] table').last();
  await expect(table).toBeVisible({ timeout: 30_000 });
  return table;
}

test.describe('Markdown table layout', () => {
  let threadId: string | null = null;
  let threadTitle: string;

  test.beforeEach(async ({ request }) => {
    ({ id: threadId, title: threadTitle } = await createThread(request));
  });

  test.afterEach(async ({ request }) => {
    if (!threadId) return;
    const response = await request.delete(`${API}/threads/${threadId}`);
    expect(response.ok()).toBeTruthy();
    threadId = null;
  });

  test('wide tables preserve column constraints and scroll horizontally', async ({ page }) => {
    const table = await openTable(page, threadTitle);
    const scrollContainer = table.locator('..');
    const cells = table.locator('tbody td');

    await expect(cells).toHaveCount(6);
    for (let index = 0; index < 6; index += 1) {
      const width = await cells.nth(index).evaluate((cell) => cell.getBoundingClientRect().width);
      expect(width).toBeGreaterThanOrEqual(192);
      expect(width).toBeLessThanOrEqual(384);
    }

    const overflow = await scrollContainer.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);

    await scrollContainer.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expect
      .poll(() => scrollContainer.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);
    await expect(cells.last()).toBeVisible();
  });

  test('a narrow pane does not squish columns below their minimum width', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 800 });
    const table = await openTable(page, threadTitle);
    const scrollContainer = table.locator('..');
    const firstCellWidth = await table
      .locator('tbody td')
      .first()
      .evaluate((cell) => cell.getBoundingClientRect().width);
    const overflow = await scrollContainer.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));

    expect(firstCellWidth).toBeGreaterThanOrEqual(192);
    expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);
  });

  test('a long cell caps its height and scrolls vertically without widening the table', async ({
    page,
  }) => {
    const table = await openTable(page, threadTitle);
    const longCellContent = table.locator('tbody td').last().locator('div');

    const tableWidth = await table.evaluate((element) => element.getBoundingClientRect().width);
    const box = await longCellContent.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    }));

    // The content overflows a capped box (9rem = 144px) and scrolls vertically
    // inside the column — automatically, no click.
    expect(box.clientHeight).toBeLessThanOrEqual(145);
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
    expect(box.overflowY).toBe('auto');

    // Scrolling the cell reveals lower content without changing table width.
    await longCellContent.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(() => longCellContent.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect
      .poll(() => table.evaluate((element) => element.getBoundingClientRect().width))
      .toBe(tableWidth);
  });

  test('the automatic-scroll cell exposes no expand affordance', async ({ page }) => {
    const table = await openTable(page, threadTitle);

    // No cell is a toggle button in the automatic-scroll model.
    await expect(table.getByRole('button')).toHaveCount(0);
    await expect(table.locator('tbody td div[tabindex]')).toHaveCount(0);
  });
});
