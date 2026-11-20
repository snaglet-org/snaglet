import { expect, test, type Locator, type Page } from '@playwright/test';
import { openApp } from './helpers/nav';

const LAYOUT_STORAGE_KEY = 'snaglet.dashboard.layoutSnapshot';
const PANE_ITEM_MIME = 'application/x-snaglet-pane-item';

async function dropProviderPaneToRight(pane: Locator): Promise<void> {
  await pane.evaluate(
    (element, { mime }) => {
      const rect = element.getBoundingClientRect();
      const dataTransfer = new DataTransfer();
      dataTransfer.setData(mime, JSON.stringify({ kind: 'providers' }));
      const eventInit: DragEventInit = {
        bubbles: true,
        cancelable: true,
        clientX: rect.right - 2,
        clientY: rect.top + rect.height / 2,
        dataTransfer,
      };
      element.dispatchEvent(new DragEvent('dragover', eventInit));
      element.dispatchEvent(new DragEvent('drop', eventInit));
    },
    { mime: PANE_ITEM_MIME }
  );
}

async function paneWidths(page: Page): Promise<number[]> {
  return page
    .locator('main [data-panel]')
    .evaluateAll((panels) => panels.map((panel) => panel.getBoundingClientRect().width));
}

async function isPaneActive(pane: Locator): Promise<boolean> {
  return pane.evaluate((element) => element.className.includes('paneActive'));
}

test.describe('pane layout invariants', () => {
  test('activates a newly split pane and swaps activation when another pane is pressed', async ({
    page,
  }) => {
    await openApp(page);

    const panes = page.locator('[data-leaf-id]');
    await expect(panes).toHaveCount(1);
    const originalId = await panes.first().getAttribute('data-leaf-id');
    if (!originalId) throw new Error('initial pane did not expose its leaf id');

    await dropProviderPaneToRight(panes.first());
    await expect(panes).toHaveCount(2);

    const originalPane = page.locator(`[data-leaf-id="${originalId}"]`);
    const insertedId = (
      await panes.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-leaf-id'))
      )
    ).find((id) => id && id !== originalId);
    if (!insertedId) throw new Error('split pane did not expose a distinct leaf id');
    const insertedPane = page.locator(`[data-leaf-id="${insertedId}"]`);
    await expect
      .poll(async () => ({
        original: await isPaneActive(originalPane),
        inserted: await isPaneActive(insertedPane),
      }))
      .toEqual({ original: false, inserted: true });

    await originalPane.click();
    await expect
      .poll(async () => ({
        original: await isPaneActive(originalPane),
        inserted: await isPaneActive(insertedPane),
      }))
      .toEqual({ original: true, inserted: false });
  });

  test('keeps repeated same-direction drops usable through resize and reload', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.addInitScript((key) => {
      if (window.sessionStorage.getItem('pane-layout-invariants-initialized') === '1') return;
      window.localStorage.removeItem(key);
      window.sessionStorage.setItem('pane-layout-invariants-initialized', '1');
    }, LAYOUT_STORAGE_KEY);
    await page.setViewportSize({ width: 1280, height: 760 });
    await openApp(page);

    const panes = page.locator('[data-leaf-id]');
    await expect(panes).toHaveCount(1);
    await dropProviderPaneToRight(panes.first());
    await expect(panes).toHaveCount(2);

    const firstSeparator = page.locator('main [role="separator"]').first();
    const separatorBox = await firstSeparator.boundingBox();
    if (!separatorBox) throw new Error('pane separator did not render');
    await page.mouse.move(separatorBox.x + separatorBox.width / 2, separatorBox.y + 20);
    await page.mouse.down();
    await page.mouse.move(separatorBox.x + 120, separatorBox.y + 20, { steps: 5 });
    await page.mouse.up();

    await dropProviderPaneToRight(panes.nth(1));
    await expect(panes).toHaveCount(3);
    await dropProviderPaneToRight(panes.nth(2));
    await expect(panes).toHaveCount(4);

    await expect
      .poll(() =>
        page.evaluate((key) => {
          const raw = window.localStorage.getItem(key);
          if (!raw) return null;
          const state = JSON.parse(raw) as {
            layout?: { children?: unknown[]; ratios?: number[] };
          };
          return {
            children: state.layout?.children?.length,
            ratios: state.layout?.ratios,
          };
        }, LAYOUT_STORAGE_KEY)
      )
      .toMatchObject({ children: 4, ratios: [25, 25, 25, 25] });

    await expect
      .poll(async () => {
        const widths = await paneWidths(page);
        return Math.min(...widths) / Math.max(...widths);
      })
      .toBeGreaterThan(0.9);

    await page.reload();
    await page.getByRole('tab').first().waitFor({ state: 'visible', timeout: 30_000 });
    await expect(panes).toHaveCount(4);
    const reloadedWidths = await paneWidths(page);
    expect(Math.min(...reloadedWidths)).toBeGreaterThan(0);
    expect(Math.min(...reloadedWidths) / Math.max(...reloadedWidths)).toBeGreaterThan(0.9);
    expect(pageErrors.filter((message) => message.includes('panel layout'))).toEqual([]);
  });

  test('repairs a stale one-panel ratio vector before Group renders and writes it back', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.addInitScript(
      ({ key }) => {
        window.localStorage.setItem(
          key,
          JSON.stringify({
            version: 4,
            activeLeafId: 'leaf-stale',
            layout: {
              kind: 'split',
              id: 'split-stale',
              direction: 'horizontal',
              ratios: [23.347, 76.653],
              children: [
                {
                  kind: 'leaf',
                  id: 'leaf-stale',
                  selection: null,
                  history: { entries: [], index: -1 },
                },
              ],
            },
          })
        );
      },
      { key: LAYOUT_STORAGE_KEY }
    );

    await openApp(page);

    await expect(page.locator('[data-leaf-id="leaf-stale"]')).toBeVisible();
    await expect(page.locator('main [data-panel]')).toHaveCount(1);
    await expect
      .poll(() =>
        page.evaluate((key) => {
          const raw = window.localStorage.getItem(key);
          return raw
            ? (JSON.parse(raw) as { layout?: { ratios?: number[] } }).layout?.ratios
            : null;
        }, LAYOUT_STORAGE_KEY)
      )
      .toEqual([100]);
    expect(pageErrors.filter((message) => message.includes('panel layout'))).toEqual([]);
  });
});
