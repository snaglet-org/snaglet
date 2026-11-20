import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { createDoc, createContainer } = vi.hoisted(() => ({
  createDoc: vi.fn(),
  createContainer: vi.fn(),
}));

vi.mock('@desktop/utils/api', () => ({
  docsApi: { create: createDoc },
  containersApi: { create: createContainer },
}));
vi.mock('@desktop/features/workspace-tree/undo/workspaceUndo', () => ({ recordCreate: vi.fn() }));
vi.mock('@desktop/utils/workspaceEvents', () => ({ emitLibraryEvent: vi.fn() }));

import { useQuickCreateHotkeys } from './useQuickCreateHotkeys';

const STAMP = '2026-01-01T00:00:00.000Z';

function press(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    metaKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  window.dispatchEvent(event);
  return event;
}

describe('useQuickCreateHotkeys', () => {
  beforeEach(() => {
    createDoc.mockReset().mockResolvedValue({
      id: 'doc-1',
      containerId: null,
      title: 'Untitled doc',
      content: '',
      sortOrder: 0,
      createdAt: STAMP,
      updatedAt: STAMP,
    });
    createContainer.mockReset().mockResolvedValue({
      id: 'container-1',
      parentId: null,
      name: 'Untitled container',
      sortOrder: 0,
      createdAt: STAMP,
      updatedAt: STAMP,
    });
  });

  it('creates a workspace-level doc on Mod+Shift+D and opens it', async () => {
    const open = vi.fn();
    const newThread = vi.fn();
    renderHook(() => useQuickCreateHotkeys(open, newThread));
    const event = press('D');
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(createDoc).toHaveBeenCalledWith({ title: 'Untitled doc', containerId: null });
    expect(open.mock.calls[0]![0]).toMatchObject({ kind: 'doc', id: 'doc-1' });
  });

  it('creates a workspace-level container on Mod+Shift+C and opens it', async () => {
    const open = vi.fn();
    const newThread = vi.fn();
    renderHook(() => useQuickCreateHotkeys(open, newThread));
    press('c', { metaKey: false, ctrlKey: true });
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(createContainer).toHaveBeenCalledWith({ name: 'Untitled container', parentId: null });
    expect(open.mock.calls[0]![0]).toMatchObject({ kind: 'container', id: 'container-1' });
  });

  it('asks for agents on Mod+Shift+T instead of creating anything', () => {
    const open = vi.fn();
    const newThread = vi.fn();
    renderHook(() => useQuickCreateHotkeys(open, newThread));
    const event = press('T');
    expect(event.defaultPrevented).toBe(true);
    expect(newThread).toHaveBeenCalledTimes(1);
    expect(createDoc).not.toHaveBeenCalled();
  });

  it('ignores the keys without Shift, with Alt, on auto-repeat and under a modal', async () => {
    const open = vi.fn();
    const newThread = vi.fn();
    renderHook(() => useQuickCreateHotkeys(open, newThread));
    press('d', { shiftKey: false });
    press('d', { altKey: true });
    press('d', { repeat: true });
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);
    press('d');
    modal.remove();
    await Promise.resolve();
    expect(createDoc).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('creates one item when the key is pressed again before the first finishes', async () => {
    const open = vi.fn();
    const newThread = vi.fn();
    renderHook(() => useQuickCreateHotkeys(open, newThread));
    press('d');
    press('d');
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(createDoc).toHaveBeenCalledTimes(1);
  });
});
