/**
 * The active pane's navigation shortcuts, end to end through PaneChrome and
 * its real history nav: ⌘Y opens Recently visited, ⌘↑ opens the parent
 * folder, and focus is remembered for moving between panes.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LayoutLeaf } from '../../layout/paneTree';
import type { DetailSelection } from '../../selection/types';
import type { AncestorContainer } from '../PathHeader/nodeAncestors';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

vi.mock('../../views/DetailRouter.js', () => ({
  DetailRouter: () => <textarea aria-label="Pane field" />,
}));
vi.mock('../PathHeader/PathHeader.js', () => ({ PathHeader: () => null }));
const tree = vi.hoisted(() => ({ ancestors: [] as AncestorContainer[] }));
vi.mock('../PathHeader/useNodeAncestors.js', () => ({ useNodeAncestors: () => tree.ancestors }));

import { focusPane } from '../../layout/paneFocus';
import { PaneChrome } from './PaneChrome';

const DOC: DetailSelection = { kind: 'doc', doc_id: 'doc-1111111111111-aaaaaaaaa' };

function makeLeaf(selection: DetailSelection = { kind: 'storage' }): LayoutLeaf {
  return {
    kind: 'leaf',
    id: 'leaf-1',
    selection,
    history: {
      entries: [{ kind: 'providers' }, selection ?? { kind: 'storage' }],
      index: 1,
    },
  };
}

function renderPane(isActive: boolean, selection?: DetailSelection) {
  const onReplaceSelection = vi.fn();
  render(
    <PaneChrome
      leaf={makeLeaf(selection)}
      isActive={isActive}
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onDropSelection={vi.fn()}
      onReplaceSelection={onReplaceSelection}
      onGoBack={vi.fn()}
      onGoForward={vi.fn()}
      onJumpToHistoryEntry={vi.fn()}
    />
  );
  return { onReplaceSelection };
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

function container(id: string, name: string, category: string | null = null): AncestorContainer {
  return { kind: 'container', id, name, category, children: [] } as unknown as AncestorContainer;
}

const UP = { key: 'ArrowUp', metaKey: true };

afterEach(() => {
  vi.restoreAllMocks();
  tree.ancestors = [];
});

describe('PaneChrome shortcuts', () => {
  it('opens the active pane’s Recently visited menu on ⌘Y', () => {
    renderPane(true);
    press({ key: 'y', metaKey: true });
    expect(screen.getByRole('menu', { name: 'Recently visited' })).toBeInTheDocument();
  });

  it('leaves an inactive pane’s menu closed', () => {
    renderPane(false);
    press({ key: 'y', metaKey: true });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('remembers where focus was in the pane, so moving back to it lands there', () => {
    renderPane(true);
    const field = screen.getByRole('textbox', { name: 'Pane field' });
    act(() => field.focus());
    act(() => field.blur());
    act(() => focusPane('leaf-1'));
    expect(field).toHaveFocus();
  });

  it('lands on the first chrome control when nothing in the pane had focus yet', () => {
    renderPane(true);
    act(() => focusPane('leaf-1'));
    expect(screen.getByRole('button', { name: /Back to/ })).toHaveFocus();
  });

  it('opens the folder holding the doc on ⌘↑, as a new visit in this pane', () => {
    const project = container('container-1111111111111-aaaaaaaaa', 'Project A', 'project');
    const folder = container('container-2222222222222-bbbbbbbbb', 'Notes');
    tree.ancestors = [project, folder];
    const { onReplaceSelection } = renderPane(true, DOC);

    expect(press(UP).defaultPrevented).toBe(true);
    expect(onReplaceSelection).toHaveBeenCalledWith({
      kind: 'container',
      container_id: folder.id,
      node: folder,
    });
  });

  it('leaves ⌘↑ alone for an item with nothing above it', () => {
    const { onReplaceSelection } = renderPane(true, DOC);
    expect(press(UP).defaultPrevented).toBe(false);
    expect(onReplaceSelection).not.toHaveBeenCalled();
  });

  it('does not open a parent for an inactive pane', () => {
    tree.ancestors = [container('container-1111111111111-aaaaaaaaa', 'Project A', 'project')];
    const { onReplaceSelection } = renderPane(false, DOC);
    press(UP);
    expect(onReplaceSelection).not.toHaveBeenCalled();
  });
});
