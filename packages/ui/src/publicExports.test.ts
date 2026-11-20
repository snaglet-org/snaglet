import { describe, expect, it } from 'vitest';
import { LeafToggle as RootLeafToggle, Tree as RootTree } from '@snaglet/ui';
import { LeafToggle } from '@snaglet/ui/leaf-toggle';
import { Tree } from '@snaglet/ui/sidebar-tree';

describe('@snaglet/ui public exports', () => {
  it('keeps root and component subpath exports aligned', () => {
    expect(RootTree).toBe(Tree);
    expect(RootLeafToggle).toBe(LeafToggle);
  });
});
