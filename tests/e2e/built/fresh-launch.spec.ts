import { expect, test } from '@playwright/test';
import { BuiltWorkspace } from '../helpers/builtWorkspace';

test.describe.configure({ mode: 'serial' });

test.describe('built Snaglet fresh launch', () => {
  let workspace: BuiltWorkspace;
  let previousApiBase: string | undefined;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    previousApiBase = process.env.VITE_API_BASE_URL;
    process.env.VITE_API_BASE_URL = 'http://127.0.0.1:1/live-api-must-not-be-used';
    try {
      workspace = await BuiltWorkspace.boot();
    } finally {
      if (previousApiBase === undefined) delete process.env.VITE_API_BASE_URL;
      else process.env.VITE_API_BASE_URL = previousApiBase;
    }
  });

  test.afterAll(async () => {
    await workspace?.dispose();
  });

  test('opens the production artifact directly to Dashboard without a setup wizard', async ({
    page,
  }) => {
    const apiRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
    });

    await page.goto(workspace.baseUrl);

    await expect(page.getByTestId('build-profile-banner')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Set up Snaglet' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Workspace' })).toBeVisible();
    // A fresh workspace opens Home with Get started beside it.
    await expect(page.getByRole('heading', { name: 'Welcome to Snaglet' }).first()).toBeVisible();

    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    await page.getByRole('treeitem', { name: /profile/i }).click();
    await expect(page.getByRole('heading', { name: 'My profile' })).toBeVisible();

    const createdName = `Built User ${Date.now()}`;
    await page.getByRole('button', { name: 'Create user' }).click();
    const modal = page.getByRole('dialog', { name: 'Create user' });
    await expect(modal).toBeVisible();
    await expect(modal.getByLabel('Name')).toBeFocused();
    await modal.getByLabel('Name').fill(createdName);
    await modal.getByLabel('Email (optional)').fill('built-user@example.com');
    await modal.getByRole('button', { name: 'Create user' }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Acting as' })).toHaveValue('local_user');
    await expect(page.getByRole('option', { name: /Built User/ })).toHaveText(
      `${createdName} (built-user@example.com)`
    );

    expect(apiRequests.length).toBeGreaterThan(0);
    expect(apiRequests.every((url) => new URL(url).origin === workspace.baseUrl)).toBe(true);
    expect(workspace.serverPort).not.toBe(4000);
    if (process.env.SNAGLET_E2E_REUSE_BUILD === 'true') expect(workspace.buildMs).toBe(0);
    else expect(workspace.buildMs).toBeGreaterThan(0);
  });
});
