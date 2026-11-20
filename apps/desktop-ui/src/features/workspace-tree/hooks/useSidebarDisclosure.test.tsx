import { act, render } from '@testing-library/react';
import { useRef, useState } from 'react';
import { expect, it } from 'vitest';
import type { LibraryTreeChild } from '@desktop/utils/api';
import { useSidebarDisclosure } from './useSidebarDisclosure';
import { requestSidebarDisclosure } from '@desktop/ws/sidebarDisclosure';
function Harness() {
  const shellRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(new Set<string>());
  const nodeIndex = new Map<string, LibraryTreeChild>([
    ['container-1', { id: 'container-1', kind: 'container' } as LibraryTreeChild],
    ['doc-1', { id: 'doc-1', kind: 'doc' } as LibraryTreeChild],
    ['hidden-container', { id: 'hidden-container', kind: 'container' } as LibraryTreeChild],
  ]);
  useSidebarDisclosure({ shellRef, hideBody: false, nodeIndex, expanded, setExpanded });
  return (
    <div data-testid="panel">
      <div ref={shellRef} data-sidebar-workspace="ready">
        <div data-row-id="container-1" aria-expanded={expanded.has('container-1')} />
        <div data-row-id="doc-1" />
      </div>
    </div>
  );
}
it('deterministic expand/collapse acknowledgments observe committed state, including repeated operations', async () => {
  const view = render(<Harness />);
  const panel = view.getByTestId('panel');
  for (const expanded of [true, true, false, false]) {
    let promise: ReturnType<typeof requestSidebarDisclosure>;
    act(() => {
      promise = requestSidebarDisclosure(panel, 'container-1', expanded);
    });
    expect(await promise!).toEqual({ node_id: 'container-1', expanded });
    expect(panel.querySelector('[data-row-id="container-1"]')?.getAttribute('aria-expanded')).toBe(
      String(expanded)
    );
  }
});
it('rejects docs, unavailable nodes, and unmounted collapsed descendants without mutation', async () => {
  const view = render(<Harness />);
  const panel = view.getByTestId('panel');
  for (const [id, error] of [
    ['doc-1', 'not_container'],
    ['missing', 'node_unavailable'],
    ['hidden-container', 'node_unavailable'],
  ]) {
    let promise: ReturnType<typeof requestSidebarDisclosure>;
    act(() => {
      promise = requestSidebarDisclosure(panel, id, true);
    });
    expect(await promise!).toEqual({ error });
  }
  expect(panel.querySelector('[data-row-id="container-1"]')?.getAttribute('aria-expanded')).toBe(
    'false'
  );
});
