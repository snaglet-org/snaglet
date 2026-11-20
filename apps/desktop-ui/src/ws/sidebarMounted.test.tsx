import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { mountedDisclosure, requestMountedDisclosure } from './sidebarMounted';
import { inspectSidebar } from './inspectSidebar';
import type { SidebarTabId } from '@snaglet/shared/types';

function Harness({ tab }: { tab: SidebarTabId }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-sidebar-mounted="ready">
      <div
        data-sidebar-disclosure=""
        data-inspect-name={`${tab} group`}
        aria-expanded={open}
        ref={mountedDisclosure(setOpen)}
      />
      {open && <div data-inspect-name="Child" />}
    </div>
  );
}

describe('mounted sidebar disclosure protocol', () => {
  it.each(['calendar', 'providers', 'tools', 'skills', 'automations'] as SidebarTabId[])(
    '%s handles are opaque and idempotent, inspect reads only mounted rows',
    async (tab) => {
      const view = render(<Harness tab={tab} />);
      const snapshot = () => inspectSidebar(view.container, true, tab);
      const initial = snapshot();
      expect(initial).toMatchObject({ kind: 'tree', state: 'ready', total_rendered: 1 });
      if (initial.kind !== 'tree') throw new Error('expected mounted tree');
      const target = initial.items[0].target!;
      expect(target).not.toContain(`${tab} group`);
      for (const expanded of [true, true, false, false]) {
        let result: unknown;
        await act(async () => {
          const pending = requestMountedDisclosure(view.container, tab, target, expanded);
          // React must commit before the mutation-observer acknowledgment.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          result = pending;
        });
        expect(await result).toEqual({ expanded });
        expect(snapshot()).toMatchObject({ total_rendered: expanded ? 2 : 1 });
        const current = snapshot();
        if (current.kind === 'tree') expect(current.items[0].expanded).toBe(expanded);
      }
      view.unmount();
      expect(await requestMountedDisclosure(view.container, tab, target, true)).toEqual({
        error: 'node_unavailable',
      });
    }
  );
  it('unissued and stale handles cannot change a disclosure', async () => {
    const view = render(<Harness tab="tools" />);
    expect(
      await requestMountedDisclosure(view.container, 'tools', '["tools","mounted","guessed"]', true)
    ).toEqual({ error: 'node_unavailable' });
    expect(inspectSidebar(view.container, true, 'tools')).toMatchObject({
      items: [{ expanded: false }],
    });
  });
  it('times out when an adapter does not commit the requested disclosure', async () => {
    vi.useFakeTimers();
    const view = render(
      <div data-sidebar-mounted="ready">
        <div data-sidebar-disclosure="" aria-expanded="false" />
      </div>
    );
    const detail = inspectSidebar(view.container, true, 'tools');
    if (detail.kind !== 'tree') throw new Error('tree expected');
    const result = requestMountedDisclosure(view.container, 'tools', detail.items[0].target!, true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toEqual({ error: 'node_unavailable' });
    vi.useRealTimers();
  });
});
it('mounted inspection reports loading, viewport distinction, selection and truncation accurately', () => {
  const view = render(
    <div data-sidebar-mounted="loading">
      {Array.from({ length: 251 }, (_, i) => (
        <div key={i} data-inspect-name={`Row ${i}`} aria-selected={i === 0} />
      ))}
    </div>
  );
  expect(inspectSidebar(view.container, true, 'tools')).toMatchObject({
    state: 'loading',
    visibility: 'mounted',
    total_rendered: 251,
    truncated: true,
  });
  const detail = inspectSidebar(view.container, true, 'tools');
  if (detail.kind !== 'tree') throw new Error('tree expected');
  expect(detail.items).toHaveLength(250);
  expect(detail.items[0]).toMatchObject({ selected: true, viewport_visible: false });
  // Selected generated rows have no semantic entity ID to report.
  expect(detail.items[0].id).toBeNull();
  expect(detail.selected_ids).toEqual([]);
});
it('batched repeated disclosure requests use setters rather than toggle stale render state', async () => {
  const view = render(<Harness tab="tools" />);
  const detail = inspectSidebar(view.container, true, 'tools');
  if (detail.kind !== 'tree') throw new Error('tree expected');
  let results!: Array<ReturnType<typeof requestMountedDisclosure>>;
  await act(async () => {
    results = [1, 2, 3].map(() =>
      requestMountedDisclosure(view.container, 'tools', detail.items[0].target!, true)
    );
  });
  expect(await Promise.all(results)).toEqual([
    { expanded: true },
    { expanded: true },
    { expanded: true },
  ]);
  expect(inspectSidebar(view.container, true, 'tools')).toMatchObject({ total_rendered: 2 });
});
