import { mountedTarget } from './sidebarMounted';
import { sidebarContainerTarget } from '@snaglet/shared/types';
import type { SidebarInspection, SidebarTabId, SidebarTreeItem } from '@snaglet/shared/types';

const MAX_ROWS = 250;
const ROW_SELECTOR =
  '[data-sidebar-disclosure], [data-sidebar-label], [data-inspect-name], [data-inspect-id], [data-table-id]';
/** Read only the mounted sidebar, never API caches or backend inventory.
 * Includes mounted rows outside the scroll viewport; collapsed descendants
 * are absent. IDs may be null for decorative/generated rows without identity.
 */
export function inspectSidebar(
  panel: HTMLElement | null,
  open: boolean,
  tab: SidebarTabId
): SidebarInspection {
  if (!open) return { kind: 'not_rendered', reason: 'closed' };
  if (!panel) return { kind: 'not_rendered', reason: 'not_mounted' };
  if (['calendar', 'providers', 'tools', 'skills', 'automations'].includes(tab))
    return inspectMounted(panel, tab);
  if (tab !== 'library' && tab !== 'agents') return { kind: 'unsupported', tab };
  const workspace = panel.querySelector<HTMLElement>('[data-sidebar-workspace]');
  const searchRoot = panel.querySelector<HTMLElement>('[data-sidebar-search]');
  const search = {
    query: searchRoot?.dataset.inspectQuery ?? '',
    filters: JSON.parse(searchRoot?.dataset.inspectFilters ?? '[]') as string[],
  };
  const root =
    tab === 'library' ? workspace : panel.querySelector<HTMLElement>('[data-sidebar-agents]');
  if (!root) return { kind: 'not_rendered', reason: 'not_mounted' };
  const rawState = tab === 'library' ? root.dataset.sidebarWorkspace : root.dataset.sidebarAgents;
  const state = rawState === 'loading' || rawState === 'error' ? rawState : 'ready';
  if (tab === 'agents') {
    const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-inspect-agent-id]'));
    const selected_ids = rows
      .filter((row) => row.dataset.inspectSelected === 'true')
      .map((row) => row.dataset.inspectAgentId!);
    return {
      kind: 'list',
      state,
      search,
      visibility: 'mounted',
      selected_ids,
      total_rendered: rows.length,
      truncated: rows.length > MAX_ROWS,
      items: rows.slice(0, MAX_ROWS).map((row) => ({
        id: row.dataset.inspectAgentId!,
        name: row.dataset.inspectName ?? '',
        role: row.dataset.inspectRole ?? '',
        selected: row.dataset.inspectSelected === 'true',
      })),
    };
  }
  const rows = Array.from(root.querySelectorAll<HTMLElement>('[role="treeitem"]'));
  const items: SidebarTreeItem[] = [];
  const stack: Array<{ level: number; item: SidebarTreeItem }> = [];
  const selected_ids: string[] = [];
  for (const row of rows.slice(0, MAX_ROWS)) {
    // The owning row's identity can live on its inner flex row. Do not
    // accidentally borrow an ID or label from a nested descendant row.
    const own = (selector: string) =>
      Array.from(row.querySelectorAll<HTMLElement>(selector)).find(
        (el) => el.closest('[role="treeitem"]') === row
      );
    const identity = row.matches(
      '[data-group-id],[data-table-id],[data-agent-row-id],[data-inspect-id]'
    )
      ? row
      : own('[data-row-id]');
    const id =
      identity?.dataset.inspectId ??
      identity?.dataset.rowId ??
      identity?.dataset.groupId ??
      identity?.dataset.tableId ??
      identity?.dataset.agentRowId ??
      null;
    const expanded = row.getAttribute('aria-expanded');
    const label = row.getAttribute('aria-label') ?? own('[title]')?.getAttribute('title') ?? '';
    const item: SidebarTreeItem = {
      id,
      name: label,
      selected: row.getAttribute('aria-selected') === 'true',
      expanded: expanded === null ? null : expanded === 'true',
      children: [],
      expandable: row.dataset.inspectKind === 'container' && id !== null,
      target: row.dataset.inspectKind === 'container' && id ? sidebarContainerTarget(id) : null,
    };
    if (item.selected && id) selected_ids.push(id);
    // Groups are sometimes siblings, not DOM parents; aria-level is canonical.
    const level =
      Number(row.getAttribute('aria-level')) ||
      ((row.parentElement?.closest('[role="treeitem"]') ? stack[stack.length - 1]?.level : 0) ??
        0) + 1;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    (stack.length ? stack[stack.length - 1].item.children : items).push(item);
    stack.push({ level, item });
  }
  return {
    kind: 'tree',
    state,
    items,
    selected_ids,
    search,
    visibility: 'mounted',
    total_rendered: rows.length,
    truncated: rows.length > MAX_ROWS,
  };
}

/** Flat mounted rows; no hierarchy is inferred from labels or backend inventory. */
function inspectMounted(panel: HTMLElement, tab: SidebarTabId): SidebarInspection {
  const root = panel.querySelector<HTMLElement>('[data-sidebar-mounted]');
  if (!root) return { kind: 'not_rendered', reason: 'not_mounted' };
  const rows = Array.from(root.querySelectorAll<HTMLElement>(ROW_SELECTOR))
    .map((el) => (el.matches('[data-sidebar-label]') ? el.parentElement! : el))
    .filter((el, index, all) => all.indexOf(el) === index);
  return {
    kind: 'tree',
    state:
      root.dataset.sidebarMounted === 'loading'
        ? 'loading'
        : root.dataset.sidebarMounted === 'error'
          ? 'error'
          : 'ready',
    visibility: 'mounted',
    search: { query: '', filters: [] },
    selected_ids: rows
      .filter(
        (row) =>
          row.getAttribute('aria-selected') === 'true' || row.dataset.inspectSelected === 'true'
      )
      .map((row) => row.dataset.inspectId ?? row.dataset.tableId ?? null)
      .filter((id): id is string => id !== null),
    total_rendered: rows.length,
    truncated: rows.length > MAX_ROWS,
    items: rows.slice(0, MAX_ROWS).map((row) => {
      const expandable = row.hasAttribute('data-sidebar-disclosure');
      const id = row.dataset.inspectId ?? row.dataset.tableId ?? null;
      const box = row.getBoundingClientRect();
      const clip = panel.getBoundingClientRect();
      const group = row.closest<HTMLElement>('[data-sidebar-row-state]');
      const rowState = group?.querySelector('[data-sidebar-disclosure]') === row ? group : null;
      return {
        id,
        name:
          row.dataset.inspectName ??
          row.querySelector('[data-sidebar-label]')?.textContent?.trim() ??
          row.getAttribute('aria-label') ??
          '',
        selected:
          row.getAttribute('aria-selected') === 'true' || row.dataset.inspectSelected === 'true',
        expanded: expandable ? row.getAttribute('aria-expanded') === 'true' : null,
        expandable,
        target: expandable ? mountedTarget(row, tab) : null,
        children: [],
        viewport_visible:
          row.getClientRects().length > 0 &&
          box.width > 0 &&
          box.height > 0 &&
          box.bottom > clip.top &&
          box.top < clip.bottom &&
          box.right > clip.left &&
          box.left < clip.right,
        ...(rowState
          ? {
              loading: rowState.getAttribute('data-sidebar-row-state') === 'loading',
              content_truncated: rowState.getAttribute('data-sidebar-files-truncated') === 'true',
            }
          : {}),
      };
    }),
  };
}
