import { safeJsonParse } from '../utils/json';

/** Activity-bar IDs shared by the UI and addressed sidebar tool. */
export const SIDEBAR_TAB_IDS = [
  'library',
  'calendar',
  'agents',
  'providers',
  'tools',
  'skills',
  'automations',
  'mcp',
  'settings',
] as const;
export type SidebarTabId = (typeof SIDEBAR_TAB_IDS)[number];
export function isSidebarTabId(value: unknown): value is SidebarTabId {
  return typeof value === 'string' && SIDEBAR_TAB_IDS.some((id) => id === value);
}
/** Old tab ids that still open the view that took them over. */
export const SIDEBAR_TAB_ALIASES: Readonly<Partial<Record<string, SidebarTabId>>> = {
  hooks: 'automations',
};
/** A tab id, or an old one mapped to its view; null for anything else. */
export function resolveSidebarTabId(value: unknown): SidebarTabId | null {
  if (isSidebarTabId(value)) return value;
  if (typeof value !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(SIDEBAR_TAB_ALIASES, value)
    ? (SIDEBAR_TAB_ALIASES[value] ?? null)
    : null;
}
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 560;
export const clampSidebarWidth = (width: number): number =>
  Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
export interface SidebarSnapshot {
  width_px?: number;
  open: boolean;
  active_tab: SidebarTabId;
  detail?: SidebarInspection;
  target?: string;
  expanded?: boolean;
  /** scroll only: metrics of the panel scroller after the animation finished. */
  scrolled?: boolean;
  scroll_top?: number;
  scroll_height?: number;
  client_height?: number;
  at_bottom?: boolean;
}
export interface SidebarCommand {
  op: 'open' | 'close' | 'status' | 'inspect' | 'expand' | 'collapse' | 'resize' | 'scroll';
  width_px?: number;
  tab?: SidebarTabId;
  target?: string;
  /** scroll only: exclusive with target. */
  to?: 'top' | 'bottom';
  /** scroll only: animation length, clamped to SIDEBAR_SCROLL_MAX_MS. */
  duration_ms?: number;
}
export const SIDEBAR_SCROLL_DEFAULT_MS = 600;
export const SIDEBAR_SCROLL_MAX_MS = 10_000;
export function clampSidebarScrollDuration(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SIDEBAR_SCROLL_DEFAULT_MS;
  return Math.min(SIDEBAR_SCROLL_MAX_MS, Math.max(0, value));
}

/** Rendered means mounted, not necessarily inside the scroll viewport. */
export interface SidebarSearchState {
  query: string;
  filters: string[];
}
export interface SidebarTreeItem {
  /** Intersection with the sidebar panel; mounted rows may lie outside it. */
  viewport_visible?: boolean;
  loading?: boolean;
  content_truncated?: boolean;
  id: string | null;
  name: string;
  selected: boolean;
  expanded: boolean | null;
  children: SidebarTreeItem[];
  expandable: boolean;
  target: string | null;
}
export type SidebarInspection =
  | { kind: 'not_rendered'; reason: 'closed' | 'not_mounted' }
  | { kind: 'unsupported'; tab: SidebarTabId }
  | {
      kind: 'tree';
      items: SidebarTreeItem[];
      selected_ids: string[];
      search: SidebarSearchState;
      truncated: boolean;
      total_rendered: number;
      state: 'ready' | 'loading' | 'error';
      visibility: 'mounted';
    }
  | {
      kind: 'list';
      items: Array<{ id: string; name: string; role: string; selected: boolean }>;
      selected_ids: string[];
      search: SidebarSearchState;
      truncated: boolean;
      total_rendered: number;
      state: 'ready' | 'loading' | 'error';
      visibility: 'mounted';
    };

/** Reject malformed or unbounded detail at the realtime boundary. */
export function isSidebarInspection(value: unknown): value is SidebarInspection {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.kind === 'not_rendered') return v.reason === 'closed' || v.reason === 'not_mounted';
  if (v.kind === 'unsupported') return isSidebarTabId(v.tab);
  if (v.kind !== 'tree' && v.kind !== 'list') return false;
  if (
    !['ready', 'loading', 'error'].includes(String(v.state)) ||
    v.visibility !== 'mounted' ||
    typeof v.truncated !== 'boolean' ||
    !Number.isInteger(v.total_rendered) ||
    Number(v.total_rendered) < 0 ||
    !Array.isArray(v.selected_ids) ||
    !v.selected_ids.every((id) => typeof id === 'string') ||
    !Array.isArray(v.items) ||
    v.items.length > 250
  )
    return false;
  const search = v.search as Record<string, unknown> | undefined;
  if (
    !search ||
    typeof search.query !== 'string' ||
    !Array.isArray(search.filters) ||
    !search.filters.every((filter) => typeof filter === 'string')
  )
    return false;
  if (v.kind === 'list')
    return v.items.every(
      (item) =>
        item &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.role === 'string' &&
        typeof item.selected === 'boolean'
    );
  let count = 0;
  const validTree = (items: unknown[], depth: number): boolean =>
    depth <= 250 &&
    items.every((item) => {
      if (++count > 250 || !item || typeof item !== 'object') return false;
      const row = item as Record<string, unknown>;
      return (
        (row.id === null || typeof row.id === 'string') &&
        typeof row.name === 'string' &&
        typeof row.selected === 'boolean' &&
        typeof row.expandable === 'boolean' &&
        (row.target === null || typeof row.target === 'string') &&
        (row.expanded === null || typeof row.expanded === 'boolean') &&
        (row.viewport_visible === undefined || typeof row.viewport_visible === 'boolean') &&
        (row.loading === undefined || typeof row.loading === 'boolean') &&
        (row.content_truncated === undefined || typeof row.content_truncated === 'boolean') &&
        Array.isArray(row.children) &&
        validTree(row.children, depth + 1)
      );
    });
  return validTree(v.items, 0);
}

export type SidebarError =
  | 'tab_unavailable'
  | 'invalid_command'
  | 'sidebar_closed'
  | 'wrong_tab'
  | 'node_unavailable'
  | 'not_container'
  | 'unsupported_target'
  | 'not_scrollable';
export function isSidebarError(value: unknown): value is SidebarError {
  return (
    typeof value === 'string' &&
    [
      'tab_unavailable',
      'invalid_command',
      'sidebar_closed',
      'wrong_tab',
      'node_unavailable',
      'not_container',
      'unsupported_target',
      'not_scrollable',
    ].includes(value)
  );
}

/** Opaque disclosure references are returned by inspect; callers echo them. */
export function sidebarContainerTarget(id: string): string {
  return JSON.stringify(['library', 'container', id]);
}
export function parseSidebarTarget(
  target: string
): { tab: SidebarTabId; kind: string; id: string } | null {
  const value = safeJsonParse<unknown>(target, null);
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !isSidebarTabId(value[0]) ||
    typeof value[1] !== 'string' ||
    typeof value[2] !== 'string' ||
    !value[2]
  )
    return null;
  return { tab: value[0], kind: value[1], id: value[2] };
}
