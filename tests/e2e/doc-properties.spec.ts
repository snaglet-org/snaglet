import { test, expect } from '@playwright/test';
import { openApp } from './helpers/nav';
import {
  createDoc,
  deleteDoc,
  openPropertiesDisclosure,
  openNodeViaPalette,
  runPrefix,
  type DocRec,
} from './helpers/workspace';

/**
 * Doc Properties — a read-only metadata panel. A doc carries no task state
 * (tasks are Database table rows), so no "Work item" group ever renders; the
 * panel is the Info list plus a Versions group (Snapshot, Versions). The
 * source toggle stays in the pane topbar.
 *
 * Behavior/outcome assertions only — semantic hooks (accessible names,
 * data-testid) + API round-trips. No styling/layout assertions beyond the
 * containment check at narrow widths.
 */
test.describe('Doc Properties — controls', () => {
  const prefix = runPrefix('docprops');
  let freshNote: DocRec;

  test.beforeAll(async () => {
    freshNote = await createDoc({ title: `${prefix}-note` });
    expect(freshNote.containerId).toBeNull();
  });

  test.afterAll(async () => {
    await deleteDoc(freshNote?.id);
  });

  test('a doc shows no Work item group', async ({ page }) => {
    await openApp(page);
    await openNodeViaPalette(page, `${prefix}-note`);
    await openPropertiesDisclosure(page);
    await expect(page.getByTestId('doc-source-toggle')).toBeVisible();
    await expect(page.locator('[data-tid="docWorkItemGroup"]')).toHaveCount(0);
    await expect(page.getByLabel('Priority')).toHaveCount(0);
    await expect(page.getByLabel('Due date')).toHaveCount(0);
  });

  test('doc controls remain usable and contained at normal and narrow widths', async ({
    page,
  }, testInfo) => {
    await openApp(page);
    await openNodeViaPalette(page, `${prefix}-note`);
    await openPropertiesDisclosure(page);

    const properties = page.getByRole('region', { name: 'Document properties' });
    const sourceToggle = page.getByTestId('doc-source-toggle');
    const snapshot = properties.getByRole('button', { name: 'Snapshot', exact: true });
    const versions = properties.getByRole('button', { name: /^Versions( \d+)? ▾$/ });

    await expect(properties).toBeVisible();
    await expect(sourceToggle).toBeVisible();
    await expect(snapshot).toBeVisible();
    await expect(versions).toBeVisible();

    const controlStyleSignatures = await Promise.all(
      [sourceToggle, snapshot, versions].map((control) =>
        control.evaluate((element) => {
          const style = window.getComputedStyle(element);
          return [
            style.height,
            style.padding,
            style.border,
            style.borderRadius,
            style.backgroundColor,
            style.fontFamily,
            style.fontSize,
            style.fontWeight,
          ].join('|');
        })
      )
    );
    expect(new Set(controlStyleSignatures).size).toBe(1);

    await sourceToggle.click();
    await expect(page.getByTestId('workspace-editor-source-textarea')).toBeVisible();
    await expect(sourceToggle).toHaveAttribute('aria-pressed', 'true');
    await sourceToggle.click();
    await expect(page.getByTestId('workspace-editor-source-textarea')).toHaveCount(0);

    await versions.click();
    await expect(page.getByRole('listbox')).toBeVisible();
    await versions.click();
    await expect(page.getByRole('listbox')).toHaveCount(0);

    await page.screenshot({ path: testInfo.outputPath('properties-normal.png'), fullPage: true });

    await page.setViewportSize({ width: 420, height: 760 });
    await expect(properties).toBeVisible();
    await expect(sourceToggle).toBeVisible();
    await expect(snapshot).toBeVisible();
    await expect(versions).toBeVisible();
    for (const control of [sourceToggle, snapshot, versions]) {
      expect(
        await control.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= window.innerWidth;
        })
      ).toBe(true);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('properties-narrow.png'), fullPage: true });
  });
});
