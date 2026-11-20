/**
 * The set of sidebar views the Dashboard can show. Add a new id here and
 * a matching entry in `ACTIVITY_BAR_ITEMS` (ActivityBar.tsx) to expose a
 * new view in the activity bar. The active view is persisted to
 * localStorage under `SIDEBAR_VIEW_STORAGE_KEY`.
 */
import type { SidebarTabId } from '@snaglet/shared/types';
import { resolveSidebarTabId } from '@snaglet/shared/types';
export type SidebarViewId = SidebarTabId;

export const SIDEBAR_VIEW_STORAGE_KEY = 'snaglet.dashboard.sidebarView';

export const DEFAULT_SIDEBAR_VIEW: SidebarViewId = 'library';

/**
 * The view to show for a persisted value: a live view, the view an alias
 * maps to (a saved `hooks` opens Automations), else the default.
 */
export function sidebarViewFromStorage(value: string | null): SidebarViewId {
  return resolveSidebarTabId(value) ?? DEFAULT_SIDEBAR_VIEW;
}
