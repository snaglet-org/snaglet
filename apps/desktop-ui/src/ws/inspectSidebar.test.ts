import { describe, expect, it } from 'vitest';
import { inspectSidebar } from './inspectSidebar';
import { isSidebarInspection } from '@snaglet/shared/types';
function panel(html: string): HTMLDivElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}
describe('mounted sidebar inspection', () => {
  it('reports closed, missing and unsupported explicitly without rows', () => {
    expect(inspectSidebar(null, false, 'agents')).toEqual({
      kind: 'not_rendered',
      reason: 'closed',
    });
    expect(inspectSidebar(null, true, 'library')).toEqual({
      kind: 'not_rendered',
      reason: 'not_mounted',
    });
    expect(inspectSidebar(panel(''), true, 'settings')).toEqual({
      kind: 'unsupported',
      tab: 'settings',
    });
    expect(
      inspectSidebar(panel('<div data-sidebar-workspace="ready"></div>'), true, 'agents')
    ).toEqual({ kind: 'not_rendered', reason: 'not_mounted' });
  });
  it('reads only mounted workspace rows with sibling group nesting and selected/expanded flags', () => {
    const root =
      panel(`<div data-sidebar-workspace="ready" data-sidebar-search data-inspect-query="demo" data-inspect-filters='["doc"]'>
      <div role="treeitem" aria-level="1" aria-label="Project" data-inspect-kind="container" aria-expanded="true"><div data-row-id="project-1"></div>
        <div role="treeitem" aria-level="2" data-group-id="threads" aria-label="Threads" aria-expanded="false"></div>
        <div role="treeitem" aria-level="2" aria-label="Doc" aria-selected="true"><div data-row-id="doc-1"></div></div>
      </div>
      <div role="treeitem" aria-level="1" data-group-id="root-items" aria-label="Docs" aria-expanded="true"></div>
      <div role="treeitem" aria-level="2" aria-label="Root doc"><div data-row-id="doc-2"></div></div>
    </div>`);
    const result = inspectSidebar(root, true, 'library');
    expect(result.kind).toBe('tree');
    if (result.kind !== 'tree') return;
    expect(result.items[0].expandable).toBe(true);
    expect(result.items[0].target).toBe('["library","container","project-1"]');
    expect(result.items[0].children[0].target).toBeNull();
    expect(result.total_rendered).toBe(5);
    expect(result.search).toEqual({ query: 'demo', filters: ['doc'] });
    expect(result.items.map((row) => row.id)).toEqual(['project-1', 'root-items']);
    expect(result.items[0].children.map((row) => [row.id, row.expanded])).toEqual([
      ['threads', false],
      ['doc-1', null],
    ]);
    expect(result.items[1].children[0].id).toBe('doc-2');
    expect(result.selected_ids).toEqual(['doc-1']);
    expect(isSidebarInspection(result)).toBe(true);
  });
  it('agents are a flat list of actual mounted rows with role and selection, not prefetched inventory', () => {
    const root =
      panel(`<div data-sidebar-search data-inspect-query="bob" data-inspect-filters='[]'></div>
      <div data-sidebar-agents="ready"><div data-inspect-agent-id="agent-1" data-inspect-name="Bob" data-inspect-role="Engineer" data-inspect-selected="true"></div></div>`);
    expect(inspectSidebar(root, true, 'agents')).toEqual({
      kind: 'list',
      state: 'ready',
      visibility: 'mounted',
      total_rendered: 1,
      truncated: false,
      selected_ids: ['agent-1'],
      search: { query: 'bob', filters: [] },
      items: [{ id: 'agent-1', name: 'Bob', role: 'Engineer', selected: true }],
    });
  });
  it('keeps semantic entity ids separate from opaque disclosure targets', () => {
    const root = panel(`<div data-sidebar-mounted="ready">
      <div data-sidebar-row-state="loaded" data-sidebar-files-truncated="true">
        <div data-sidebar-disclosure data-inspect-id="skill-1" data-inspect-name="demo-skill" data-inspect-selected="true" aria-expanded="true"></div>
        <div data-inspect-name="SKILL.md"></div>
      </div>
      <div data-sidebar-disclosure aria-expanded="false"><span data-sidebar-label>Generated group</span></div>
    </div>`);
    const result = inspectSidebar(root, true, 'skills');
    expect(result.kind).toBe('tree');
    if (result.kind !== 'tree') return;
    expect(result.selected_ids).toEqual(['skill-1']);
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toMatchObject({
      id: 'skill-1',
      name: 'demo-skill',
      selected: true,
      expandable: true,
      loading: false,
      content_truncated: true,
    });
    expect(result.items[0].target).not.toBe(result.items[0].id);
    expect(result.items[0].target).toContain('"mounted"');
    expect(result.items[1]).toMatchObject({
      id: null,
      name: 'SKILL.md',
      expandable: false,
      target: null,
    });
    expect(result.items[1]).not.toHaveProperty('loading');
    expect(result.items[1]).not.toHaveProperty('content_truncated');
    expect(result.items[2]).toMatchObject({
      id: null,
      name: 'Generated group',
      expandable: true,
    });
    expect(result.items[2].target).toContain('"mounted"');
  });
  it('distinguishes loading and empty views', () => {
    const loading = inspectSidebar(
      panel('<div data-sidebar-agents="loading"></div>'),
      true,
      'agents'
    );
    expect(loading).toMatchObject({ kind: 'list', state: 'loading', items: [] });
    expect(
      inspectSidebar(panel('<div data-sidebar-workspace="ready"></div>'), true, 'library')
    ).toMatchObject({ kind: 'tree', state: 'ready', items: [] });
  });
  it('caps snapshots and states truncation without inventing hidden descendants', () => {
    const root = panel(
      `<div data-sidebar-agents="ready">${Array.from({ length: 251 }, (_, i) => `<div data-inspect-agent-id="${i}" data-inspect-name="Agent ${i}" data-inspect-role="Role"></div>`).join('')}</div>`
    );
    const result = inspectSidebar(root, true, 'agents');
    expect(result).toMatchObject({ truncated: true, total_rendered: 251 });
    if (result.kind === 'list') expect(result.items).toHaveLength(250);
    expect(isSidebarInspection(result)).toBe(true);
    expect(isSidebarInspection({ kind: 'list', items: 'not-an-array' })).toBe(false);
  });
  it('rejects non-boolean optional mounted row metadata', () => {
    const valid = inspectSidebar(
      panel(
        '<div data-sidebar-mounted="ready"><div data-inspect-id="tool-1" data-inspect-name="Tool"></div></div>'
      ),
      true,
      'tools'
    );
    expect(isSidebarInspection(valid)).toBe(true);
    if (valid.kind !== 'tree') return;
    for (const field of ['viewport_visible', 'loading', 'content_truncated'] as const) {
      expect(
        isSidebarInspection({
          ...valid,
          items: [{ ...valid.items[0], [field]: 'true' }],
        })
      ).toBe(false);
    }
  });
});
