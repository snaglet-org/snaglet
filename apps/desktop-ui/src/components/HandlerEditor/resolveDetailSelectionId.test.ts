/**
 * resolveDetailSelectionId — id extraction from a `PANE_ITEM_MIME` payload
 * (a JSON-serialized `DetailSelection`) for the drag-node-into-editor path.
 * Pins one case per `DetailSelection` branch a
 * sidebar can legitimately drag: doc/thread/container/image (TreeRow),
 * agent (AgentsList), tool (ToolsView), hook (HooksView), file
 * (WorkspaceTree's file group).
 */
import { describe, expect, it } from 'vitest';
import { resolveDetailSelectionId } from './resolveDetailSelectionId';

describe('resolveDetailSelectionId', () => {
  it('resolves a doc selection', () => {
    expect(resolveDetailSelectionId({ kind: 'doc', doc_id: 'doc-1' })).toEqual({
      id: 'doc-1',
      label: 'doc',
    });
  });

  it('resolves a thread selection', () => {
    expect(resolveDetailSelectionId({ kind: 'thread', thread_id: 'thread-1' })).toEqual({
      id: 'thread-1',
      label: 'thread',
    });
  });

  it('resolves a container selection', () => {
    expect(resolveDetailSelectionId({ kind: 'container', container_id: 'container-1' })).toEqual({
      id: 'container-1',
      label: 'container',
    });
  });

  it('resolves an agent selection, using the agent name as the label', () => {
    expect(
      resolveDetailSelectionId({ kind: 'agent', agent: { id: 'agent-1', name: 'Rosie' } })
    ).toEqual({ id: 'agent-1', label: 'Rosie' });
  });

  it('resolves a tool selection', () => {
    expect(
      resolveDetailSelectionId({ kind: 'tool', tool: { id: 'tool-1', name: 'weather' } })
    ).toEqual({ id: 'tool-1', label: 'weather' });
  });

  it('resolves a hook selection using hookName (hooks have no separate id field)', () => {
    expect(
      resolveDetailSelectionId({ kind: 'hook', hook: { hookName: 'on-thread-create' } })
    ).toEqual({ id: 'on-thread-create', label: 'on-thread-create' });
  });

  it('resolves a file selection', () => {
    expect(
      resolveDetailSelectionId({ kind: 'file', node: { id: 'file-1', name: 'notes.txt' } })
    ).toEqual({ id: 'file-1', label: 'notes.txt' });
  });

  it('resolves an image selection', () => {
    expect(
      resolveDetailSelectionId({
        kind: 'image',
        image_id: 'image-1',
        node: { id: 'image-1', name: 'Diagram' },
      })
    ).toEqual({
      id: 'image-1',
      label: 'Diagram',
    });
  });

  it('returns null for a kind with no insertable id (e.g. settings surfaces)', () => {
    expect(resolveDetailSelectionId({ kind: 'profile' })).toBeNull();
  });

  it('returns null for malformed/incomplete payloads', () => {
    expect(resolveDetailSelectionId({ kind: 'agent', agent: {} })).toBeNull();
    expect(resolveDetailSelectionId(null)).toBeNull();
    expect(resolveDetailSelectionId('not an object')).toBeNull();
    expect(resolveDetailSelectionId({})).toBeNull();
  });
});
