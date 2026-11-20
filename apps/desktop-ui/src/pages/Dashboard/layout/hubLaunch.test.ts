import { describe, expect, it } from 'vitest';
import { hubLaunchLeafId, openLaunchPanes } from './hubLaunch';
import { createLeaf, findLeaf, leafIds, splitLeaf } from './paneTree';
import type { LayoutNode } from './paneTreeTypes';

const docSelection = { kind: 'doc', doc_id: 'doc-1' } as const;

function shown(layout: LayoutNode) {
  return leafIds(layout).map((id) => findLeaf(layout, id)?.selection ?? null);
}

describe('openLaunchPanes', () => {
  it('opens Home with Get started to its right, Home keeping the focus', () => {
    const layout = createLeaf(null);
    const next = openLaunchPanes({ layout, activeLeafId: null }, layout.id, 'home-and-get-started');
    expect(shown(next.layout)).toEqual([{ kind: 'hub' }, { kind: 'get-started' }]);
    expect(next.activeLeafId).toBe(layout.id);
    expect(next.layout.kind === 'split' && next.layout.direction).toBe('horizontal');
  });

  it('adds Get started beside a Home the launch already opened, without a second Home', () => {
    const layout = createLeaf({ kind: 'hub' });
    const next = openLaunchPanes(
      { layout, activeLeafId: layout.id },
      layout.id,
      'home-and-get-started'
    );
    expect(shown(next.layout)).toEqual([{ kind: 'hub' }, { kind: 'get-started' }]);
  });

  it('opens Get started alone, or Home alone, in the launch pane', () => {
    const layout = createLeaf(null);
    const state = { layout, activeLeafId: null };
    expect(shown(openLaunchPanes(state, layout.id, 'get-started').layout)).toEqual([
      { kind: 'get-started' },
    ]);
    expect(shown(openLaunchPanes(state, layout.id, 'home').layout)).toEqual([{ kind: 'hub' }]);
    expect(openLaunchPanes(state, layout.id, 'empty')).toBe(state);
  });

  it('leaves a pane the person filled, a missing pane, or an open Get started alone', () => {
    const filled = createLeaf(docSelection);
    const state = { layout: filled, activeLeafId: filled.id };
    expect(openLaunchPanes(state, filled.id, 'home-and-get-started')).toBe(state);

    const fresh = createLeaf(null);
    const missing = { layout: fresh, activeLeafId: null };
    expect(openLaunchPanes(missing, 'leaf-gone', 'home-and-get-started')).toBe(missing);

    const root = createLeaf({ kind: 'hub' });
    const both = splitLeaf(root, root.id, 'right', { kind: 'get-started' });
    const restored = { layout: both, activeLeafId: root.id };
    expect(openLaunchPanes(restored, root.id, 'home-and-get-started')).toBe(restored);
  });
});

describe('hubLaunchLeafId', () => {
  it('fills the only pane of a fresh window', () => {
    const layout = createLeaf(null);
    expect(hubLaunchLeafId({ layout, activeLeafId: null })).toBe(layout.id);
  });

  it('fills the active pane when every restored pane is empty', () => {
    const root = createLeaf(null);
    const split = splitLeaf(root, root.id, 'right', null);
    const [, second] = leafIds(split);
    expect(hubLaunchLeafId({ layout: split, activeLeafId: second! })).toBe(second);
  });

  it('leaves a restored layout alone when any pane shows something', () => {
    const root = createLeaf(null);
    const split = splitLeaf(root, root.id, 'right', docSelection);
    const [first] = leafIds(split);
    expect(hubLaunchLeafId({ layout: split, activeLeafId: first! })).toBeNull();
    expect(hubLaunchLeafId({ layout: createLeaf(docSelection), activeLeafId: null })).toBeNull();
  });
});
