/**
 * The pane's error boundary is scoped to the item it crashed on: opening a
 * different item in the same pane renders that item, not the previous item's crash panel.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LayoutLeaf } from '../../layout/paneTree';
import type { DetailSelection } from '../../selection/types';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const mounts = vi.hoisted(() => ({ count: 0 }));

vi.mock('../../views/DetailRouter.js', async () => {
  const { useEffect } = await import('react');
  return {
    DetailRouter: ({ selection }: { selection: DetailSelection }) => {
      useEffect(() => {
        mounts.count += 1;
      }, []);
      if (selection?.kind === 'doc' && selection.doc_id === 'doc-broken') {
        throw new Error('view exploded');
      }
      return <div>{selection?.kind === 'doc' ? `doc body ${selection.doc_id}` : 'other body'}</div>;
    },
  };
});
vi.mock('../PaneHistoryNav/PaneHistoryNav.js', () => ({ PaneHistoryNav: () => null }));
vi.mock('../PathHeader/PathHeader.js', () => ({ PathHeader: () => null }));
vi.mock('../PathHeader/useNodeAncestors.js', () => ({ useNodeAncestors: () => [] }));

import { PaneChrome } from './PaneChrome';

function leaf(selection: DetailSelection): LayoutLeaf {
  return { kind: 'leaf', id: 'leaf-1', selection, history: { entries: [], index: -1 } };
}

function pane(selection: DetailSelection) {
  return (
    <PaneChrome
      leaf={leaf(selection)}
      isActive
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onDropSelection={vi.fn()}
      onReplaceSelection={vi.fn()}
      onGoBack={vi.fn()}
      onGoForward={vi.fn()}
      onJumpToHistoryEntry={vi.fn()}
    />
  );
}

describe('PaneChrome error boundary', () => {
  it('clears a crash panel when the pane opens a different item', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = render(pane({ kind: 'doc', doc_id: 'doc-broken' }));
    expect(screen.getByText('view exploded')).toBeInTheDocument();

    view.rerender(pane({ kind: 'doc', doc_id: 'doc-healthy' }));

    expect(screen.queryByText('view exploded')).not.toBeInTheDocument();
    expect(screen.getByText('doc body doc-healthy')).toBeInTheDocument();
    error.mockRestore();
  });

  it('keeps the crash panel for the same item (a refreshed cache is not a new item)', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = render(pane({ kind: 'doc', doc_id: 'doc-broken' }));
    view.rerender(pane({ kind: 'doc', doc_id: 'doc-broken', focusMessageId: 'message-1' }));
    expect(screen.getByText('view exploded')).toBeInTheDocument();
    error.mockRestore();
  });

  it('never remounts a healthy view when the selection changes', () => {
    mounts.count = 0;
    const view = render(pane({ kind: 'doc', doc_id: 'doc-a' }));
    view.rerender(pane({ kind: 'doc', doc_id: 'doc-b' }));
    expect(screen.getByText('doc body doc-b')).toBeInTheDocument();
    expect(mounts.count).toBe(1);
  });
});
