import { describe, expect, it } from 'vitest';
import {
  activePaneSelectionIds,
  closeLeaf,
  createLeaf,
  openNodeIds,
  repairPaneLayout,
  splitLeaf,
  splitLeafWithResult,
  updateSplitRatios,
  type LayoutNode,
  type LayoutSplit,
} from './paneTree';
import type { DetailSelection } from '../selection/types';

describe('paneTree', () => {
  it('returns the inserted leaf id for a successful split', () => {
    const root = createLeaf({ kind: 'thread', thread_id: 'thread-1' });

    const result = splitLeafWithResult(root, root.id, 'right', { kind: 'providers' });

    expect(result.insertedLeafId).not.toBeNull();
    expect(result.layout.kind).toBe('split');
    if (result.layout.kind !== 'split') return;
    expect(result.layout.children[0]).toBe(root);
    expect(result.layout.children[1]).toMatchObject({
      id: result.insertedLeafId,
      kind: 'leaf',
      selection: { kind: 'providers' },
    });
  });

  it('returns the original layout and no inserted id when the target is missing', () => {
    const root = createLeaf({ kind: 'thread', thread_id: 'thread-1' });

    const result = splitLeafWithResult(root, 'leaf-missing', 'right', { kind: 'providers' });

    expect(result).toEqual({ layout: root, insertedLeafId: null });
    expect(result.layout).toBe(root);
  });

  it('splits to the requested side with a custom new-pane ratio', () => {
    const root = createLeaf({ kind: 'thread', thread_id: 'thread-1' });

    const next = splitLeaf(root, root.id, 'right', { kind: 'providers' }, { newPaneRatio: 0.3 });

    expect(next.kind).toBe('split');
    if (next.kind !== 'split') return;

    expect(next.direction).toBe('horizontal');
    expect(next.ratios).toEqual([70, 30]);
    expect(next.children[0]).toMatchObject({ kind: 'leaf', id: root.id });
    expect(next.children[1]).toMatchObject({
      kind: 'leaf',
      selection: { kind: 'providers' },
    });
  });

  it('places a left split before the original pane', () => {
    const root = createLeaf({ kind: 'thread', thread_id: 'thread-1' });

    const next = splitLeaf(root, root.id, 'left', { kind: 'providers' }, { newPaneRatio: 0.25 });

    expect(next.kind).toBe('split');
    if (next.kind !== 'split') return;

    expect(next.direction).toBe('horizontal');
    expect(next.ratios).toEqual([25, 75]);
    expect(next.children[0]).toMatchObject({
      kind: 'leaf',
      selection: { kind: 'providers' },
    });
    expect(next.children[1]).toMatchObject({ kind: 'leaf', id: root.id });
  });

  // The renderer keys panes by leaf id and reconciles them in place, so an
  // untouched pane only keeps its live PaneChrome instance (voice session,
  // scroll, unsaved draft) if the tree op hands its leaf back by reference. If
  // splitLeaf ever cloned the original leaf, React would see a new object and,
  // combined with the element-type shift, remount it. These pin the data-layer
  // half of the "splitting a pane must not remount other panes" guarantee; the
  // React half is proven by PaneLayout.test.tsx.
  it('reuses the original leaf object (by reference) when splitting it', () => {
    const root = createLeaf({ kind: 'thread', thread_id: 'thread-1' });

    const next = splitLeaf(root, root.id, 'right', { kind: 'providers' });

    expect(next.kind).toBe('split');
    if (next.kind !== 'split') return;
    const original = next.children.find((c) => c.id === root.id);
    // Exact same object, not a copy — this is what lets the pane survive a split.
    expect(original).toBe(root);
  });

  it('leaves an untouched sibling identical (by reference) when the other pane splits', () => {
    const root = createLeaf({ kind: 'thread', thread_id: 'A' });
    const split = splitLeaf(root, root.id, 'right', { kind: 'thread', thread_id: 'B' });
    expect(split.kind).toBe('split');
    if (split.kind !== 'split') return;

    // [A, B] for a 'right' split. Split B; A must be handed back untouched.
    const paneA = split.children[0];
    const paneB = split.children[1];
    const next = splitLeaf(split, paneB.id, 'bottom', { kind: 'thread', thread_id: 'C' });
    expect(next.kind).toBe('split');
    if (next.kind !== 'split') return;

    // A's subtree is the exact same object; only B's slot became a new split.
    expect(next.children[0]).toBe(paneA);
    expect(next.children[1].kind).toBe('split');
  });

  it('inserts repeated same-direction drops as evenly rebalanced siblings', () => {
    const first = createLeaf({ kind: 'thread', thread_id: 'A' });
    const two = splitLeaf(first, first.id, 'right', { kind: 'thread', thread_id: 'B' });
    if (two.kind !== 'split') throw new Error('expected split');
    const second = two.children[1];

    const three = splitLeaf(two, second.id, 'right', { kind: 'thread', thread_id: 'C' });
    if (three.kind !== 'split') throw new Error('expected split');
    const third = three.children[2];
    const four = splitLeaf(three, third.id, 'right', { kind: 'thread', thread_id: 'D' });
    if (four.kind !== 'split') throw new Error('expected split');

    expect(four.direction).toBe('horizontal');
    expect(four.children).toHaveLength(4);
    expect(four.ratios).toEqual([25, 25, 25, 25]);
    expect(four.children.map((child) => child.id).slice(0, 3)).toEqual(
      three.children.map((child) => child.id)
    );
  });

  it('rebalances a same-direction cohort after resize and keeps cross-direction nesting', () => {
    const first = createLeaf({ kind: 'thread', thread_id: 'A' });
    const split = splitLeaf(first, first.id, 'right', { kind: 'thread', thread_id: 'B' });
    if (split.kind !== 'split') throw new Error('expected split');
    const resized = updateSplitRatios(split, split.id, [80, 20]);
    if (resized.kind !== 'split') throw new Error('expected split');

    const third = splitLeaf(resized, resized.children[1].id, 'right', {
      kind: 'thread',
      thread_id: 'C',
    });
    if (third.kind !== 'split') throw new Error('expected split');
    expect(third.ratios).toEqual([33.334, 33.333, 33.333]);

    const nested = splitLeaf(third, third.children[2].id, 'bottom', {
      kind: 'thread',
      thread_id: 'D',
    });
    if (nested.kind !== 'split') throw new Error('expected split');
    expect(nested.children).toHaveLength(3);
    expect(nested.children[2]).toMatchObject({ kind: 'split', direction: 'vertical' });
  });

  it('preserves split identity when a resize is unchanged at panel precision', () => {
    const first = createLeaf({ kind: 'thread', thread_id: 'A' });
    const split = splitLeaf(first, first.id, 'right', { kind: 'thread', thread_id: 'B' });
    if (split.kind !== 'split') throw new Error('expected split');
    const stable = updateSplitRatios(split, split.id, [50.0004, 49.9996]);
    if (stable.kind !== 'split') throw new Error('expected split');

    expect(stable).toBe(split);
    expect(stable.ratios).toBe(split.ratios);
  });

  it('normalizes remaining ratios after close without disturbing sibling order', () => {
    const first = createLeaf({ kind: 'thread', thread_id: 'A' });
    const two = splitLeaf(first, first.id, 'right', { kind: 'thread', thread_id: 'B' });
    if (two.kind !== 'split') throw new Error('expected split');
    const three = splitLeaf(two, two.children[1].id, 'right', {
      kind: 'thread',
      thread_id: 'C',
    });
    if (three.kind !== 'split') throw new Error('expected split');
    const survivorIds = [three.children[0].id, three.children[2].id];

    const closed = closeLeaf(three, three.children[1].id);
    if (closed.kind !== 'split') throw new Error('expected split');
    expect(closed.children.map((child) => child.id)).toEqual(survivorIds);
    expect(closed.ratios).toEqual([50.001, 49.999]);
  });
});

function splitWith(ratios: number[], childCount = ratios.length): LayoutSplit {
  return {
    kind: 'split',
    id: 'split-under-test',
    direction: 'horizontal',
    children: Array.from({ length: childCount }, (_, index) => ({
      ...createLeaf({ kind: 'thread', thread_id: `thread-${index}` }),
      id: `leaf-${index}`,
    })),
    ratios,
  };
}

describe('repairPaneLayout', () => {
  it.each([
    { label: 'wrong length', ratios: [100], expected: [50, 50] },
    { label: 'NaN', ratios: [Number.NaN, 50], expected: [50, 50] },
    { label: 'Infinity', ratios: [Number.POSITIVE_INFINITY, 50], expected: [50, 50] },
    { label: 'zero', ratios: [0, 100], expected: [50, 50] },
    { label: 'negative', ratios: [-10, 110], expected: [50, 50] },
    { label: 'wrong total', ratios: [20, 20], expected: [50, 50] },
  ])('repairs $label ratios deterministically', ({ ratios, expected }) => {
    const result = repairPaneLayout(splitWith(ratios, 2));
    expect((result.layout as LayoutSplit).ratios).toEqual(expected);
    expect(result.repairs).toHaveLength(1);
  });

  it('forces a one-child split to exactly [100]', () => {
    const result = repairPaneLayout(splitWith([23.347, 76.653], 1));
    expect((result.layout as LayoutSplit).ratios).toEqual([100]);
    expect(result.repairs[0]).toMatchObject({
      splitId: 'split-under-test',
      childIds: ['leaf-0'],
      previousRatios: [23.347, 76.653],
      nextRatios: [100],
    });
  });

  it('enforces the practical minimum when feasible', () => {
    const result = repairPaneLayout(splitWith([98, 1, 1]));
    expect((result.layout as LayoutSplit).ratios).toEqual([80, 10, 10]);
  });

  it('degrades to even positive shares when the minimum is impossible', () => {
    const result = repairPaneLayout(splitWith([90, ...Array.from({ length: 10 }, () => 1)]));
    const ratios = (result.layout as LayoutSplit).ratios;
    expect(ratios).toEqual([9.09, ...Array.from({ length: 10 }, () => 9.091)]);
    expect(ratios.reduce((sum, ratio) => sum + ratio, 0)).toBeCloseTo(100, 3);
  });

  it('preserves an already-valid tree and ratio vector by reference at panel precision', () => {
    const valid = splitWith([23.3474, 76.6526]);
    const result = repairPaneLayout(valid);

    expect(result.layout).toBe(valid);
    expect((result.layout as LayoutSplit).ratios).toBe(valid.ratios);
    expect(result.repairs).toEqual([]);
  });

  it('repairs nested splits recursively without changing valid siblings', () => {
    const validSibling = createLeaf({ kind: 'thread', thread_id: 'stable' });
    const invalidNested = splitWith([70, 30], 1);
    const root: LayoutNode = {
      kind: 'split',
      id: 'root-split',
      direction: 'vertical',
      ratios: [60, 40],
      children: [validSibling, invalidNested],
    };

    const result = repairPaneLayout(root);
    if (result.layout.kind !== 'split') throw new Error('expected split');
    expect(result.layout.children[0]).toBe(validSibling);
    expect((result.layout.children[1] as LayoutSplit).ratios).toEqual([100]);
    expect(result.layout.ratios).toBe(root.ratios);
  });
});

describe('activePaneSelectionIds', () => {
  const allNull = {
    nodeId: null,
    threadId: null,
    toolId: null,
    hookId: null,
    skillId: null,
    settingsId: null,
    mcpConnectionId: null,
    providerId: null,
    providerModelId: null,
    tableId: null,
    automationId: null,
  };

  it('returns all-null without an active leaf id', () => {
    const root = createLeaf({ kind: 'thread', thread_id: 'thread-1' });
    expect(activePaneSelectionIds(root, null)).toEqual(allNull);
  });

  it('returns all-null when the leaf id is not in the tree', () => {
    const root = createLeaf({ kind: 'thread', thread_id: 'thread-1' });
    expect(activePaneSelectionIds(root, 'leaf-missing')).toEqual(allNull);
  });

  it('resolves an automation selection to automationId only', () => {
    const root = createLeaf({ kind: 'automation-detail', automation_id: 'automation-1' });
    expect(activePaneSelectionIds(root, root.id)).toEqual({
      ...allNull,
      automationId: 'automation-1',
    });
  });

  it('resolves a thread selection to threadId and nodeId', () => {
    const root = createLeaf({ kind: 'thread', thread_id: 'thread-1' });
    expect(activePaneSelectionIds(root, root.id)).toEqual({
      ...allNull,
      nodeId: 'thread-1',
      threadId: 'thread-1',
    });
  });

  it('resolves an image selection to its workspace node id', () => {
    const root = createLeaf({ kind: 'image', image_id: 'image-1' });
    expect(activePaneSelectionIds(root, root.id)).toEqual({
      ...allNull,
      nodeId: 'image-1',
    });
  });

  it('resolves a doc selection to nodeId only', () => {
    const root = createLeaf({ kind: 'doc', doc_id: 'doc-1' });
    expect(activePaneSelectionIds(root, root.id)).toEqual({
      ...allNull,
      nodeId: 'doc-1',
    });
  });

  it('resolves a tool selection to toolId only', () => {
    const selection = { kind: 'tool', tool: { id: 'tool-1' } } as unknown as DetailSelection;
    const root = createLeaf(selection);
    expect(activePaneSelectionIds(root, root.id)).toEqual({
      ...allNull,
      toolId: 'tool-1',
    });
  });

  it('resolves a hook selection to hookId only', () => {
    const selection = {
      kind: 'hook',
      hook: { hookName: 'on-save' },
    } as unknown as DetailSelection;
    const root = createLeaf(selection);
    expect(activePaneSelectionIds(root, root.id)).toEqual({
      ...allNull,
      hookId: 'on-save',
    });
  });

  it('resolves a skill file selection to skillId only', () => {
    const root = createLeaf({
      kind: 'skill',
      skill_id: 'skill-1',
      slug: 'release',
      path: 'SKILL.md',
    });
    expect(activePaneSelectionIds(root, root.id)).toEqual({
      ...allNull,
      skillId: 'skill-1',
    });
  });

  it('does not treat the legacy provider catalog as a settings row', () => {
    const root = createLeaf({ kind: 'providers' });
    expect(activePaneSelectionIds(root, root.id)).toEqual(allNull);
  });

  it('resolves a focused provider model to the provider activity tree', () => {
    const root = createLeaf({
      kind: 'provider',
      provider_id: 'anthropic',
      name: 'Anthropic',
      provider_type: 'llm',
      focusModelId: 'model-row-1',
    });
    expect(activePaneSelectionIds(root, root.id)).toEqual({
      ...allNull,
      providerId: 'anthropic',
      providerModelId: 'model-row-1',
    });
  });

  it('resolves an MCP client connection to its activity-tree row', () => {
    const root = createLeaf({
      kind: 'mcp-client-connection',
      client_id: 'client-1',
      name: 'Claude Code',
    });
    expect(activePaneSelectionIds(root, root.id)).toEqual({
      ...allNull,
      mcpConnectionId: 'client:client-1',
    });
  });

  it('resolves an MCP server connection to its activity-tree row', () => {
    const root = createLeaf({
      kind: 'mcp-server-connection',
      server_id: 'github',
      name: 'GitHub',
    });
    expect(activePaneSelectionIds(root, root.id)).toEqual({
      ...allNull,
      mcpConnectionId: 'server:github',
    });
  });

  it('resolves a catalog table to its Database row, not a workspace node', () => {
    const root = createLeaf({ kind: 'table', table_id: 'table-1111111111111-aaaaaaaaa' });
    expect(activePaneSelectionIds(root, root.id)).toEqual({
      ...allNull,
      tableId: 'table-1111111111111-aaaaaaaaa',
    });
    expect(openNodeIds(root).size).toBe(0);
  });

  it('reads the ACTIVE leaf, not a sibling', () => {
    const root = createLeaf({ kind: 'thread', thread_id: 'A' });
    const split = splitLeaf(root, root.id, 'right', { kind: 'doc', doc_id: 'B' });
    expect(split.kind).toBe('split');
    if (split.kind !== 'split') return;
    const docLeaf = split.children[1];
    expect(activePaneSelectionIds(split, docLeaf.id)).toEqual({
      ...allNull,
      nodeId: 'B',
    });
  });
});
