import { describe, expect, it } from 'vitest';
import { workspaceNodeId } from './types';

describe('workspaceNodeId', () => {
  it('reads a doc id without a hydrated node', () => {
    expect(workspaceNodeId({ kind: 'doc', doc_id: 'd-1' })).toBe('d-1');
  });

  it('reads a thread id without a hydrated node', () => {
    expect(workspaceNodeId({ kind: 'thread', thread_id: 't-1' })).toBe('t-1');
  });

  it('reads a container id without a hydrated node', () => {
    expect(workspaceNodeId({ kind: 'container', container_id: 'c-1' })).toBe('c-1');
  });

  it('reads an image id without a hydrated node', () => {
    expect(workspaceNodeId({ kind: 'image', image_id: 'img-1' })).toBe('img-1');
  });

  it('returns null for a null selection', () => {
    expect(workspaceNodeId(null)).toBeNull();
  });

  it('returns null for kinds with no workspace-tree path', () => {
    expect(workspaceNodeId({ kind: 'agent', agent: { id: 'a-1' } as never })).toBeNull();
    expect(workspaceNodeId({ kind: 'providers' })).toBeNull();
    expect(workspaceNodeId({ kind: 'profile' })).toBeNull();
    expect(
      workspaceNodeId({ kind: 'file', node: { kind: 'file', id: 'f-1' } as never })
    ).toBeNull();
  });
});
