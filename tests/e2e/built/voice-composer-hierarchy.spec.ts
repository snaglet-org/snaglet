import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { BuiltWorkspace } from '../helpers/builtWorkspace';
import { openNodeViaPalette, runPrefix } from '../helpers/workspace';

/**
 * The composer keeps its primary actions in the bubble and wraps the mode
 * toggles onto a rail below it; Listen on a message plays it with Voice off.
 *
 * Messages have no public write API (they come from runs), so the two fixture
 * messages are written straight into this throwaway workspace's database.
 */

test.describe.configure({ mode: 'serial' });

interface ApiEnvelope<T> {
  data: T;
}

interface IdRecord {
  id: string;
}

interface SpeakRequest {
  agentId?: string;
  text: string;
}

let workspace: BuiltWorkspace;

async function postData<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(`${workspace.apiUrl}${path}`, { data });
  expect(
    response.ok(),
    `POST ${path}: HTTP ${response.status()} ${await response.text()}`
  ).toBeTruthy();
  return ((await response.json()) as ApiEnvelope<T>).data;
}

async function openThread(page: Page, title: string): Promise<void> {
  await page.goto(workspace.baseUrl);
  await openNodeViaPalette(page, title);
  await expect(page.getByLabel('Message composer')).toHaveAttribute('contenteditable', 'true', {
    timeout: 30_000,
  });
}

async function assertComposerHierarchy(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  const shell = page.getByTestId('composer-shell');
  const bubble = page.getByTestId('message-composer');
  const rail = page.getByTestId('composer-secondary-rail');
  const primaryActions = page.getByTestId('composer-primary-actions');

  await expect(shell).toBeVisible();
  await expect(bubble).toBeVisible();
  await expect(rail).toBeVisible();
  await expect(page.getByRole('group', { name: 'Composer secondary controls' })).toBeVisible();
  await expect(primaryActions.getByLabel('Attach image')).toBeVisible();
  await expect(primaryActions.getByLabel('Send message')).toBeVisible();
  await expect(primaryActions.getByTestId('voice-toggle')).toHaveCount(0);
  await expect(primaryActions.getByTestId('voice-mode-button')).toHaveCount(0);
  await expect(primaryActions.getByTestId('vision-mode-button')).toHaveCount(0);

  await expect(rail.getByTestId('voice-toggle')).toBeVisible();
  await expect(rail.getByTestId('voice-mode-button')).toBeVisible();
  await expect(rail.getByTestId('vision-mode-button')).toBeVisible();
  await expect(rail.getByLabel('Attach image')).toHaveCount(0);
  await expect(rail.getByLabel('Send message')).toHaveCount(0);

  const geometry = await shell.evaluate((shellElement) => {
    const bubbleElement = shellElement.querySelector<HTMLElement>(
      '[data-testid="message-composer"]'
    );
    const railElement = shellElement.querySelector<HTMLElement>(
      '[data-testid="composer-secondary-rail"]'
    );
    if (!bubbleElement || !railElement) throw new Error('composer regions missing');
    const shellRect = shellElement.getBoundingClientRect();
    const bubbleRect = bubbleElement.getBoundingClientRect();
    const railRect = railElement.getBoundingClientRect();
    const visibleButtons = Array.from(shellElement.querySelectorAll<HTMLElement>('button')).filter(
      (button) => button.getClientRects().length > 0
    );
    return {
      bubbleBeforeRail:
        Boolean(
          bubbleElement.compareDocumentPosition(railElement) & Node.DOCUMENT_POSITION_FOLLOWING
        ) && bubbleRect.bottom <= railRect.top,
      regionsInsideShell:
        bubbleRect.left >= shellRect.left - 1 &&
        bubbleRect.right <= shellRect.right + 1 &&
        railRect.left >= shellRect.left - 1 &&
        railRect.right <= shellRect.right + 1,
      noHorizontalOverflow:
        document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
        shellElement.scrollWidth <= shellElement.clientWidth &&
        bubbleElement.scrollWidth <= bubbleElement.clientWidth &&
        railElement.scrollWidth <= railElement.clientWidth,
      widths: {
        document: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
        shell: [shellElement.scrollWidth, shellElement.clientWidth],
        bubble: [bubbleElement.scrollWidth, bubbleElement.clientWidth],
        rail: [railElement.scrollWidth, railElement.clientWidth],
      },
      railChildren: Array.from(railElement.querySelectorAll<HTMLElement>('*'))
        .map((element) => ({
          tag: element.tagName,
          testId: element.dataset.testid ?? '',
          text: element.textContent?.trim().slice(0, 40) ?? '',
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          left: Math.round(element.getBoundingClientRect().left),
          right: Math.round(element.getBoundingClientRect().right),
        }))
        .filter((item) => item.scrollWidth > item.clientWidth),
      allButtonsInsideViewport: visibleButtons.every((button) => {
        const rect = button.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= window.innerWidth;
      }),
    };
  });

  expect(
    geometry,
    `composer geometry at ${width}px: ${JSON.stringify({ widths: geometry.widths, railChildren: geometry.railChildren })}`
  ).toMatchObject({
    bubbleBeforeRail: true,
    regionsInsideShell: true,
    noHorizontalOverflow: true,
    allButtonsInsideViewport: true,
  });
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  workspace = await BuiltWorkspace.boot();
});

test.afterAll(async () => {
  await workspace?.dispose();
});

test.describe('Voice composer hierarchy and message re-listen', () => {
  test('keeps primary actions in the bubble, wraps modes below, and re-listens with Voice off', async ({
    page,
    request,
  }) => {
    const prefix = runPrefix('voice-composer');
    const threadTitle = `${prefix}-thread`;
    const userMessageId = `${prefix}-user-message`;
    const agentMessageId = `${prefix}-agent-message`;
    const userText = `USER_RELISTEN_${prefix}`;
    const agentText = `AGENT_RELISTEN_${prefix}`;

    const agent = await postData<IdRecord>(request, '/agents', { name: 'Voice Agent' });
    const [user] = await workspace.query<IdRecord>(
      'SELECT id FROM users ORDER BY created_at LIMIT 1'
    );
    expect(user, 'the built workspace seeds a local user').toBeDefined();
    const thread = await postData<IdRecord>(request, '/threads', {
      title: threadTitle,
      agentId: agent.id,
    });

    const now = Date.now();
    await workspace.query(`INSERT INTO nodes (id, type) SELECT unnest($1::text[]), 'message'`, [
      [userMessageId, agentMessageId],
    ]);
    await workspace.query(
      `INSERT INTO messages (id, thread_id, user_id, agent_id, role, content, created_at)
       VALUES ($1, $3, $4, NULL, 'user', $6, $7),
              ($2, $3, NULL, $5, 'assistant', $8, $9)`,
      [
        userMessageId,
        agentMessageId,
        thread.id,
        user?.id,
        agent.id,
        userText,
        new Date(now).toISOString(),
        agentText,
        new Date(now + 1).toISOString(),
      ]
    );

    await page.addInitScript(() => {
      localStorage.setItem('snaglet.dashboard.chat.renderMode', 'md');
      const audioEvents: string[] = [];
      class FakeAudioContext {
        destination = {};

        decodeAudioData(): Promise<AudioBuffer> {
          return Promise.resolve({} as AudioBuffer);
        }

        createBufferSource(): AudioBufferSourceNode {
          const source = {
            buffer: null,
            onended: null,
            connect: () => undefined,
            start: () => audioEvents.push('start'),
            stop: () => audioEvents.push('stop'),
          };
          return source as unknown as AudioBufferSourceNode;
        }

        close(): Promise<void> {
          return Promise.resolve();
        }
      }
      const voiceWindow = window as unknown as {
        AudioContext: typeof AudioContext;
        __e2eAudioEvents: string[];
      };
      voiceWindow.AudioContext = FakeAudioContext as unknown as typeof AudioContext;
      voiceWindow.__e2eAudioEvents = audioEvents;
    });

    const speakRequests: SpeakRequest[] = [];
    await page.route('**/api/voice/speak-message', async (route) => {
      speakRequests.push(route.request().postDataJSON() as SpeakRequest);
      await route.fulfill({
        status: 200,
        contentType: 'audio/wav',
        body: Buffer.alloc(44),
      });
    });

    await openThread(page, threadTitle);
    await expect(page.getByTestId('voice-mode-button')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('voice-toggle')).toHaveAttribute('aria-pressed', 'false');

    await assertComposerHierarchy(page, 1280);
    await assertComposerHierarchy(page, 400);
    await assertComposerHierarchy(page, 1280);

    const userRow = page.locator(`[data-message-id="${userMessageId}"]`);
    await userRow.hover();
    await userRow.getByRole('button', { name: 'Listen' }).click();
    await expect.poll(() => speakRequests).toEqual([{ text: userText }]);
    await expect(userRow.getByRole('button', { name: 'Stop' })).toBeVisible();
    await userRow.getByRole('button', { name: 'Stop' }).click();
    await expect(userRow.getByRole('button', { name: 'Listen' })).toBeVisible();

    const agentRow = page.locator(`[data-message-id="${agentMessageId}"]`);
    await agentRow.hover();
    await agentRow.getByRole('button', { name: 'Listen' }).click();
    await expect
      .poll(() => speakRequests)
      .toEqual([{ text: userText }, { agentId: agent.id, text: agentText }]);
    await expect(agentRow.getByRole('button', { name: 'Stop' })).toBeVisible();
    await agentRow.getByRole('button', { name: 'Stop' }).click();
    await expect(agentRow.getByRole('button', { name: 'Listen' })).toBeVisible();

    const audioEvents = await page.evaluate(
      () => (window as unknown as { __e2eAudioEvents: string[] }).__e2eAudioEvents
    );
    expect(audioEvents).toEqual(['start', 'stop', 'start', 'stop']);
    await expect(page.getByTestId('voice-mode-button')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('voice-toggle')).toHaveAttribute('aria-pressed', 'false');
  });
});
