import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocTreeNode } from '@desktop/utils/api';
import { __resetTableCatalogForTests } from '@desktop/features/database/useTableCatalog';
import { WorkspaceView } from './WorkspaceView';
import { ActivityBar } from './ActivityBar';
import type { SidebarViewId } from './views';

const api = vi.hoisted(() => ({
  listTree: vi.fn(),
  listTables: vi.fn(),
}));

vi.mock('@desktop/utils/api', async () => {
  const actual = await vi.importActual<typeof import('@desktop/utils/api')>('@desktop/utils/api');
  return {
    ...actual,
    containersApi: { ...actual.containersApi, listTree: api.listTree },
    tablesApi: { ...actual.tablesApi, list: api.listTables },
  };
});

const timestamp = '2026-01-01T00:00:00.000Z';

const doc: DocTreeNode = {
  kind: 'doc',
  id: 'doc-1111111111111-aaaaaaaaa',
  containerId: null,
  title: 'Test doc',
  content: '',
  sortOrder: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
};

interface HarnessProps {
  initialView?: SidebarViewId;
  onNodeClick?: () => void;
  onViewChange?: (mode: SidebarViewId) => void;
}

function Harness({ initialView = 'library', onNodeClick = vi.fn(), onViewChange }: HarnessProps) {
  const [view, setView] = useState<SidebarViewId>(initialView);
  return (
    <>
      <ActivityBar
        active={view}
        onSelect={(next) => {
          onViewChange?.(next);
          setView(next);
        }}
      />
      <WorkspaceView onNodeClick={onNodeClick} hideBody={view !== 'library'} />
    </>
  );
}

async function switchView(label: 'Workspace' | 'Calendar') {
  await userEvent.click(screen.getByRole('tab', { name: label }));
}

beforeEach(() => {
  __resetTableCatalogForTests();
  api.listTree.mockReset().mockResolvedValue([doc]);
  api.listTables.mockReset().mockResolvedValue({ tables: [] });
});

describe('WorkspaceView across activity-bar switches', () => {
  it('hides the tree body on another tab, keeps the search bar, and restores without a refetch', async () => {
    const onNodeClick = vi.fn();
    render(<Harness onNodeClick={onNodeClick} />);
    await screen.findByText('Test doc');
    const searchCount = () =>
      screen.queryAllByRole('searchbox').length + screen.queryAllByPlaceholderText(/Search/).length;
    expect(searchCount()).toBeGreaterThan(0);

    await switchView('Calendar');
    expect(screen.queryByText('Test doc')).not.toBeInTheDocument();
    // Compact mode: the search widget stays mounted above the other view.
    expect(searchCount()).toBeGreaterThan(0);

    await switchView('Workspace');
    expect(await screen.findByText('Test doc')).toBeInTheDocument();

    // No pane was opened or replaced, and the tree never refetched.
    expect(onNodeClick).not.toHaveBeenCalled();
    expect(api.listTree).toHaveBeenCalledTimes(1);
  });
});

describe('WorkspaceView', () => {
  it('keeps the header + as the workspace create picker', async () => {
    render(<Harness />);
    await screen.findByText('Test doc');

    await userEvent.click(screen.getByRole('button', { name: 'Create at root' }));
    expect(screen.getByRole('menuitem', { name: /Container/ })).toBeInTheDocument();
  });
});
