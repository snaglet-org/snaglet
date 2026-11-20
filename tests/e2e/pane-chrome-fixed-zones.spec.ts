import { expect, test } from '@playwright/test';
import { openApp } from './helpers/nav';
import {
  createContainer,
  deleteContainer,
  openNodeViaPalette,
  runPrefix,
  type ContainerRec,
} from './helpers/workspace';

test.describe('Pane chrome fixed edges and center-only overflow', () => {
  const prefix = runPrefix('pane-chrome');
  let root: ContainerRec;
  let middle: ContainerRec;
  let deep: ContainerRec;
  let short: ContainerRec;

  test.beforeAll(async () => {
    root = await createContainer({ name: `${prefix}-root-with-a-deliberately-long-name` });
    middle = await createContainer({
      name: `${prefix}-middle-with-another-deliberately-long-name`,
      parentId: root.id,
    });
    deep = await createContainer({
      name: `${prefix}-deep-context-with-a-deliberately-long-name`,
      parentId: middle.id,
    });
    short = await createContainer({ name: `${prefix}-short` });
  });

  test.afterAll(async () => {
    await deleteContainer(root?.id);
    await deleteContainer(short?.id);
  });

  test('keeps edge controls fixed while wheel input scrolls only the center rail', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 700, height: 760 });
    await openApp(page);
    await openNodeViaPalette(page, deep.name);

    const pane = page.locator('[data-leaf-id]').first();
    const left = pane.locator('[data-pane-chrome-zone="left"]');
    const center = pane.locator('[data-pane-chrome-zone="center"]');
    const right = pane.locator('[data-pane-chrome-zone="right"]');
    await expect(left).toBeVisible();
    await expect(center).toBeVisible();
    await expect(right).toBeVisible();
    await expect(right.getByRole('radiogroup', { name: 'View mode' })).toBeVisible();
    const openInSidebar = center.getByTitle('Open in sidebar');
    await expect(openInSidebar).toBeAttached();
    await expect(right.getByTitle('Open in sidebar')).toHaveCount(0);
    await expect(right.getByRole('button', { name: 'New tab' })).toBeVisible();
    await expect(right.getByRole('button', { name: 'Close pane' })).toBeVisible();

    await expect
      .poll(() => center.evaluate((el) => el.scrollWidth > el.clientWidth), { timeout: 10_000 })
      .toBe(true);

    await center.evaluate((el) => {
      el.scrollLeft = 0;
    });
    await expect
      .poll(() =>
        center.evaluate((rail) => {
          const button = rail.querySelector<HTMLElement>('[title="Open in sidebar"]');
          if (!button) return false;
          const railRect = rail.getBoundingClientRect();
          const buttonRect = button.getBoundingClientRect();
          return buttonRect.right <= railRect.left || buttonRect.left >= railRect.right;
        })
      )
      .toBe(true);

    const before = { left: await left.boundingBox(), right: await right.boundingBox() };
    const consumed = await center.evaluate((el) => {
      el.scrollLeft = 0;
      const event = new WheelEvent('wheel', { deltaY: 80, bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      return {
        defaultPrevented: event.defaultPrevented,
        scrollLeft: el.scrollLeft,
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
        direction: getComputedStyle(el).direction,
        cancelable: event.cancelable,
      };
    });
    expect(consumed.defaultPrevented, JSON.stringify(consumed)).toBe(true);
    expect(consumed.scrollLeft).toBeGreaterThan(0);
    expect(await left.boundingBox()).toEqual(before.left);
    expect(await right.boundingBox()).toEqual(before.right);

    const boundary = await center.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
      const before = el.scrollLeft;
      const event = new WheelEvent('wheel', { deltaY: 80, bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      return { before, after: el.scrollLeft, defaultPrevented: event.defaultPrevented };
    });
    expect(boundary.after).toBe(boundary.before);
    expect(boundary.defaultPrevented).toBe(false);

    const horizontal = await center.evaluate((el) => {
      const before = el.scrollLeft;
      const event = new WheelEvent('wheel', {
        deltaX: -24,
        deltaY: 4,
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(event);
      return { before, after: el.scrollLeft, defaultPrevented: event.defaultPrevented };
    });
    expect(horizontal.defaultPrevented).toBe(false);
    // Synthetic events have no browser default scroll, so unchanged here means
    // Snaglet did not double-handle the native horizontal gesture.
    expect(horizontal.after).toBe(horizontal.before);

    await page.setViewportSize({ width: 1440, height: 760 });
    await openNodeViaPalette(page, short.name);
    await expect
      .poll(() => center.evaluate((el) => el.scrollWidth <= el.clientWidth), { timeout: 10_000 })
      .toBe(true);
    const noOverflow = await center.evaluate((el) => {
      const before = el.scrollLeft;
      const event = new WheelEvent('wheel', { deltaY: 80, bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      return { before, after: el.scrollLeft, defaultPrevented: event.defaultPrevented };
    });
    expect(noOverflow.after).toBe(noOverflow.before);
    expect(noOverflow.defaultPrevented).toBe(false);
  });
});
