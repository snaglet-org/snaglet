import { act } from '@testing-library/react';
import { expect } from 'vitest';
import type { SidebarTabId } from '@snaglet/shared/types';
import { inspectSidebar } from '../ws/inspectSidebar';
import { requestMountedDisclosure } from '../ws/sidebarMounted';

/** Exercise a real rendered adapter without calling a navigation/enablement control. */
export async function checkSidebarDisclosures(panel: HTMLElement, tab: SidebarTabId) {
  const initial = inspectSidebar(panel, true, tab);
  if (initial.kind !== 'tree') throw new Error('Expected mounted tree');
  const disclosures = initial.items.filter((item) => item.expandable);
  expect(disclosures.length).toBeGreaterThan(0);
  for (const item of disclosures) {
    // Restore first so later children of a section remain mounted.
    for (const expanded of [!item.expanded, !item.expanded, item.expanded!]) {
      let pending!: ReturnType<typeof requestMountedDisclosure>;
      await act(async () => {
        const fresh = inspectSidebar(panel, true, tab);
        if (fresh.kind !== 'tree') throw new Error('tree expected');
        const current = fresh.items.find((row) => row.name === item.name && row.expandable);
        if (!current) throw new Error(`Missing ${item.name}`);
        pending = requestMountedDisclosure(panel, tab, current.target!, expanded);
      });
      expect(await pending).toEqual({ expanded });
    }
  }
}
