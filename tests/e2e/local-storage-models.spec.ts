// Note: this Playwright spec is kept consistent with the component by hand and
// is not executed as part of this change (it needs the full app running under
// Playwright). It mirrors VoiceModelsSection's current contract: the section
// is titled "Voice models", the install button reads "Download voice models",
// and the per-component Remove / "Enable and download" rows render from the storage report
// regardless of the global voice-model install state (here always
// 'not-installed', while individual models are present).
import { test, expect } from '@playwright/test';
import { gotoView } from './helpers/nav';

const model = {
  id: 'tts:amy',
  component: 'tts',
  name: 'Amy (US, warm)',
  description: 'Calm, clear US-English narrator.',
  path: '/tmp/models/piper/amy',
  bytes: 2048,
  expectedBytes: 2048,
  installed: true,
  removable: true,
  disabled: false,
};

async function routeStorageShell(page: import('@playwright/test').Page) {
  await page.route('**/api/snaglet-home', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { active: '/tmp/snaglet', override: null, saved: [] } });
      return;
    }
    await route.fallback();
  });
  await page.route('**/api/voice/models/status', async (route) => {
    await route.fulfill({ json: { state: 'not-installed' } });
  });
}

async function openLocalStorage(page: import('@playwright/test').Page) {
  await gotoView(page, 'Settings');
  await page.getByRole('treeitem', { name: 'Local storage' }).click();
  await expect(page.getByRole('heading', { name: 'Local storage' })).toBeVisible();
}

test.describe('Settings → Data → Local storage', () => {
  test('removes a local model, updates the total, then enables and downloads it again', async ({
    page,
  }) => {
    page.on('dialog', (dialog) => void dialog.accept());
    let storage = {
      categories: [{ key: 'models', path: '/tmp/models', bytes: 3072, removable: true }],
      localModels: [model],
      totalBytes: 3072,
    };

    await page.route('**/api/feature-flags', async (route) => {
      await route.fulfill({
        json: { success: true, data: { local_model_removal_ui: true } },
      });
    });
    await routeStorageShell(page);
    await page.route('**/api/snaglet-home/storage', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: storage });
        return;
      }
      await route.fallback();
    });
    await page.route('**/api/snaglet-home/storage/local-models/**', async (route) => {
      if (route.request().method() === 'DELETE') {
        storage = {
          ...storage,
          localModels: [{ ...storage.localModels[0], installed: false, bytes: 0, disabled: true }],
          totalBytes: 1024,
        };
        await route.fulfill({ json: storage });
        return;
      }
      if (route.request().method() === 'POST') {
        storage = {
          ...storage,
          localModels: [
            { ...storage.localModels[0], installed: true, bytes: 2048, disabled: false },
          ],
          totalBytes: 3072,
        };
        await route.fulfill({ json: storage });
        return;
      }
      await route.fallback();
    });
    await openLocalStorage(page);
    await expect(page.getByText('Amy (US, warm)')).toBeVisible();
    await expect(page.getByText('3 KB', { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Remove' }).click();
    // Removal now confirms through an in-DOM modal (not window.confirm).
    const confirmDialog = page.getByRole('dialog', { name: /Remove .*\?/ });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.getByText('Removed from this device')).toBeVisible();
    await expect(page.getByText('1 KB', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enable and download' })).toBeVisible();

    await page.getByRole('button', { name: 'Enable and download' }).click();
    await expect(page.getByRole('button', { name: 'Remove' })).toBeVisible();
    await expect(page.getByText('3 KB', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Removed from this device')).toBeHidden();
  });

  test('does not flash the per-component removal controls while the enabled flag is loading', async ({
    page,
  }) => {
    let releaseFlag!: () => void;
    const flagGate = new Promise<void>((resolve) => {
      releaseFlag = resolve;
    });
    let deleteRequests = 0;
    page.on('request', (request) => {
      if (request.method() === 'DELETE' && request.url().includes('/api/snaglet-home/storage')) {
        deleteRequests += 1;
      }
    });
    await page.route('**/api/feature-flags', async (route) => {
      await flagGate;
      await route.fulfill({
        json: { success: true, data: { local_model_removal_ui: true } },
      });
    });
    await routeStorageShell(page);
    await page.route('**/api/snaglet-home/storage', async (route) => {
      await route.fulfill({
        json: {
          categories: [
            { key: 'models', path: '/tmp/models', bytes: 2048, removable: true },
            { key: 'logs', path: '/tmp/logs', bytes: 128, removable: true },
          ],
          localModels: [model],
          totalBytes: 2176,
        },
      });
    });

    await openLocalStorage(page);
    const storagePane = page.getByRole('main');
    // While the removal flag is still loading: the Voice-models section and its
    // always-available download affordance are present, but the flag-gated
    // REMOVAL controls must not flash in. (The informational per-component row
    // renders from the storage report regardless.)
    await expect(storagePane.getByText('Voice models', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Clear' })).toHaveCount(1);
    expect(deleteRequests).toBe(0);

    releaseFlag();
    // Flag resolves enabled: the per-component Remove control appears, and the
    // models category gains its own Clear button.
    await expect(storagePane.getByText('Voice models', { exact: true })).toBeVisible();
    await expect(storagePane.getByText(model.name)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear' })).toHaveCount(2);
    expect(deleteRequests).toBe(0);
  });

  for (const scenario of ['disabled', 'absent', 'error'] as const) {
    test(`fails closed when the feature flag is ${scenario}`, async ({ page }) => {
      let deleteRequests = 0;
      page.on('request', (request) => {
        if (request.method() === 'DELETE' && request.url().includes('/api/snaglet-home/storage')) {
          deleteRequests += 1;
        }
      });
      await page.route('**/api/feature-flags', async (route) => {
        if (scenario === 'error') {
          await route.fulfill({ status: 500, json: { error: 'flag read failed' } });
          return;
        }
        await route.fulfill({
          json: {
            success: true,
            data: scenario === 'disabled' ? { local_model_removal_ui: false } : {},
          },
        });
      });
      await routeStorageShell(page);
      await page.route('**/api/snaglet-home/storage', async (route) => {
        await route.fulfill({
          json: {
            categories: [
              { key: 'models', path: '/tmp/models', bytes: 2048, removable: true },
              { key: 'logs', path: '/tmp/logs', bytes: 128, removable: true },
            ],
            localModels: [
              model,
              {
                ...model,
                id: 'tts:disabled',
                name: 'Removed voice',
                disabled: true,
                installed: false,
              },
            ],
            totalBytes: 2176,
          },
        });
      });

      await openLocalStorage(page);
      const storagePane = page.getByRole('main');
      // Flag off: the installed component's informational row still renders
      // (rows come from the storage report, not the flag), but
      // its Remove button and the removed component's "Enable and download" row
      // are both flag-gated away. The download affordance is never flag-gated.
      await expect(storagePane.getByText(model.name)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Clear' })).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Enable and download' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Download voice models' })).toHaveCount(1);
      expect(deleteRequests).toBe(0);
    });
  }
});
