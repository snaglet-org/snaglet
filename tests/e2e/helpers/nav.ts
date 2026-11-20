import type { Page } from '@playwright/test';

/**
 * SPA navigation helpers.
 *
 * Snaglet is a single-page app: all views live in the Dashboard component at the
 * app root (http://localhost:3001). There are NO client-side routes like
 * `/agents` or `/chat` — calling `page.goto('/agents')` boots the app but
 * does not select a view, leaving tests asserting against an arbitrary
 * default panel. That mismatch was the root cause of the surface 5-8 / 12
 * UI failures (harness drift, not app bugs).
 *
 * Instead, views are selected via the ActivityBar, which renders each entry
 * as a `role="tab"` with an `aria-label` equal to its label. We boot the app
 * once at `/` and switch views by clicking the tab — no app instrumentation
 * (data-testid) required.
 *
 * Canonical sidebar views (see ActivityBar.tsx):
 *   Workspace | Calendar | Agents | Providers | Tools | Automations | MCP | Settings
 */

export type SidebarView =
  | 'Workspace'
  | 'Calendar'
  | 'Agents'
  | 'Providers'
  | 'Tools'
  | 'Automations'
  | 'MCP'
  | 'Settings';

/**
 * Boot the SPA at its root. Always use this instead of `page.goto('/<route>')`.
 * Waits for the ActivityBar to be present so the app shell is interactive.
 */
export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  // The ActivityBar tablist is the app-shell readiness signal.
  await page.getByRole('tab').first().waitFor({ state: 'visible', timeout: 30_000 });
}

/**
 * Select a sidebar view via the ActivityBar tab. Boots the app first if the
 * tablist isn't present yet, so a single `gotoView(page, 'Agents')` is enough
 * to replace a `page.goto('/agents')` call.
 */
export async function gotoView(page: Page, view: SidebarView): Promise<void> {
  const anyTab = page.getByRole('tab').first();
  if (!(await anyTab.isVisible().catch(() => false))) {
    await openApp(page);
  }
  const tab = page.getByRole('tab', { name: view, exact: true });
  await tab.waitFor({ state: 'visible', timeout: 15_000 });
  // The ActivityBar is a toggle: clicking the already-active tab collapses the
  // sidebar while aria-selected stays true, so a blind click can close the very
  // panel the caller asked for (and the check below still passes). This bites
  // after a reload, which restores the selected view. Selecting a view that is
  // already selected is a no-op.
  if ((await tab.getAttribute('aria-selected')) !== 'true') {
    await tab.click();
  }
  // Confirm the view is actually selected. The active ActivityBar tab gets
  // aria-selected="true" (Tabs.tsx), so this is a real readiness signal rather
  // than just "the tab element exists".
  await page
    .getByRole('tab', { name: view, exact: true, selected: true })
    .waitFor({ state: 'visible', timeout: 15_000 });
}

/** Shortcut: open the Agents view (agent lifecycle, identity, edit panel). */
export const gotoAgents = (page: Page) => gotoView(page, 'Agents');

/** Shortcut: open the Workspace view (workspace tree, containers, docs). */
export const gotoLibrary = (page: Page) => gotoView(page, 'Workspace');
