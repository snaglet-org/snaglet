import { test, expect } from '@playwright/test';
import { openApp, gotoView } from './helpers/nav';

/**
 * UI verification suite — design language contract checks (focus rings,
 * typography floors, control sizing, responsive layout, a11y smoke).
 */

test.describe('UI Design Language — Visual Contracts', () => {
  test('focus ring is visible and meets contrast on interactive elements', async ({ page }) => {
    await openApp(page);

    // Focus the first ActivityBar tab
    const firstTab = page.getByRole('tab').first();
    await firstTab.focus();

    // Check computed focus outline
    const outline = await firstTab.evaluate((el) => {
      const computed = window.getComputedStyle(el);
      return {
        outlineWidth: computed.outlineWidth,
        outlineStyle: computed.outlineStyle,
        outlineColor: computed.outlineColor,
        boxShadow: computed.boxShadow,
      };
    });

    // Expect either outline or box-shadow focus indicator (not 'none')
    const hasFocusIndicator =
      (outline.outlineStyle !== 'none' && outline.outlineWidth !== '0px') ||
      outline.boxShadow !== 'none';

    expect(hasFocusIndicator).toBeTruthy();
  });

  // Floors mirror the codified design contract (typeScale.ts
  // PANE_TYPE_FLOORS): interactive CONTROL labels (buttons, inputs) stop at
  // 11px, while metadata/tree labels (`--text-xs`, role=treeitem rows) stop
  // at 10px — the tree's responsive density step lands there by design when
  // the sidebar is narrow (WorkspaceTree.module.scss @container tree).
  test('typography floors — controls ≥ 11px, tree/metadata labels ≥ 10px', async ({ page }) => {
    await openApp(page);
    await gotoView(page, 'Workspace');

    const tooSmall: string[] = [];
    const check = async (selector: string, floor: number) => {
      const elements = await page.locator(selector).all();
      for (const el of elements.slice(0, 15)) {
        const isVisible = await el.isVisible().catch(() => false);
        if (!isVisible) continue;

        const fontSize = await el.evaluate((node) => {
          const computed = window.getComputedStyle(node);
          return parseFloat(computed.fontSize);
        });

        const text = await el.innerText().catch(() => '');
        if (text.trim() && fontSize < floor) {
          tooSmall.push(`${fontSize}px (< ${floor}px): "${text.slice(0, 30)}"`);
        }
      }
    };

    await check('button, input', 11);
    await check('[role="treeitem"]', 10);

    expect(tooSmall).toEqual([]);
  });

  test('compact controls meet 28px minimum height', async ({ page }) => {
    await openApp(page);

    // Check ActivityBar tabs (compact controls)
    const tabs = await page.getByRole('tab').all();
    const undersized: string[] = [];

    for (const tab of tabs.slice(0, 5)) {
      const box = await tab.boundingBox();
      if (box && box.height < 28) {
        const label = await tab.getAttribute('aria-label');
        undersized.push(`${box.height.toFixed(1)}px: ${label}`);
      }
    }

    expect(undersized).toEqual([]);
  });

  test('command palette opens with keyboard, closes with Escape', async ({ page }) => {
    await openApp(page);
    const isMac = process.platform === 'darwin';

    // Open via hotkey
    await page.keyboard.press(isMac ? 'Meta+k' : 'Control+k');
    const dialog = page.getByRole('dialog', { name: 'Quick search' });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Input receives focus automatically
    const input = page.getByRole('textbox', { name: 'Quick search' });
    await expect(input).toBeFocused();

    // Close via Escape
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 3_000 });
  });

  test('Settings → Profile dirty state and save flow', async ({ page }) => {
    await gotoView(page, 'Settings');
    await page
      .getByRole('treeitem', { name: /profile/i })
      .first()
      .click();

    const header = page.getByRole('heading', { name: 'My profile' });
    await expect(header).toBeVisible({ timeout: 10_000 });

    const nameInput = page.locator('#profile-name');
    const original = await nameInput.inputValue();
    const edited = `${original}_edit`;

    // Edit triggers dirty state
    await nameInput.fill(edited);
    await expect(page.locator('span[aria-live="polite"]')).toHaveText(/unsaved changes/i);

    const saveBtn = page.getByRole('button', { name: 'Save', exact: true });
    await expect(saveBtn).toBeEnabled();

    // Save
    await saveBtn.click();
    await expect(page.locator('span[aria-live="polite"]')).toHaveText(/saved|up to date/i, {
      timeout: 10_000,
    });

    // Restore original
    await nameInput.fill(original);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('span[aria-live="polite"]')).toHaveText(/saved|up to date/i, {
      timeout: 10_000,
    });
  });
});

test.describe('Responsive Layout & Pane Behavior', () => {
  test('app shell renders without horizontal scroll at 1024px width', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await openApp(page);

    // Check document body scrollWidth vs clientWidth
    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });

    expect(hasHorizontalScroll).toBe(false);
  });

  test('narrow viewport (768px) — sidebar remains accessible', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await openApp(page);

    // At narrow width, sidebar may become a drawer or remain visible but condensed
    // Check that navigation is still reachable
    const tabs = page.getByRole('tab');
    await expect(tabs.first()).toBeVisible();
  });
});

test.describe('Accessibility Smoke', () => {
  test('Settings panels have proper heading hierarchy', async ({ page }) => {
    await gotoView(page, 'Settings');
    await page
      .getByRole('treeitem', { name: /profile/i })
      .first()
      .click();

    // Main heading is h1
    const h1 = page.getByRole('heading', { level: 1, name: 'My profile' });
    await expect(h1).toBeVisible();
  });

  test('aria-live region announces status changes', async ({ page }) => {
    await gotoView(page, 'Settings');
    await page
      .getByRole('treeitem', { name: /profile/i })
      .first()
      .click();

    const liveRegion = page.locator('span[aria-live="polite"]');
    // The region stays MOUNTED so later changes are announced, but idle it
    // renders empty — an empty span has no box, so it is attached
    // rather than "visible". Idle silence is the contract.
    await expect(liveRegion).toBeAttached();
    await expect(liveRegion).toHaveText('');

    // ...and it actually announces when the status changes, which is what this
    // test is named for.
    await page.locator('#profile-name').fill('aria-live probe');
    await expect(liveRegion).toHaveText(/unsaved changes/i);
  });
});
