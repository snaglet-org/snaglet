import { describe, it, expect } from 'vitest';
import { nodeCopyLink } from './treeUtils';

describe('nodeCopyLink — wiki link grammar', () => {
  it('emits [Label](id) for a prefixed id (scheme dropped — the id carries its type)', () => {
    expect(nodeCopyLink('doc-123', 'My Doc')).toBe('[My Doc](doc-123)');
    expect(nodeCopyLink('container-9', 'Auth')).toBe('[Auth](container-9)');
    expect(nodeCopyLink('image-7', 'Pic')).toBe('[Pic](image-7)');
  });

  it('escapes ] and \\ in the label so it cannot break the link text', () => {
    expect(nodeCopyLink('doc-1', 'a]b\\c')).toBe('[a\\]b\\\\c](doc-1)');
  });

  it('falls back to the id when the label is empty (null thread title)', () => {
    expect(nodeCopyLink('thread-1', '')).toBe('[thread-1](thread-1)');
    expect(nodeCopyLink('thread-1', null)).toBe('[thread-1](thread-1)');
  });
});
