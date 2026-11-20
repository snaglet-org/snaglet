import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { RelatedTableItems, TableEntry, TableField } from '@snaglet/shared/types';
import { DashboardNavigationProvider } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { TableEntryValueView } from '@desktop/pages/Dashboard/views/TableView/TableEntryValueView';
import { SnagletReferenceChip } from './SnagletReferenceChip';
import {
  __resetSnagletItemTitlesForTests,
  rememberItem,
  syncRelatedItems,
} from './snagletItemTitles';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, containersApi: { ...actual.containersApi, listTree: async () => [] } };
});
vi.mock('@desktop/features/rich-markdown/preview/WikiLinkPreviewModal', () => ({
  WikiLinkPreviewModal: ({ kind, id }: { kind: string; id: string }) => (
    <div role="dialog" aria-label="Preview">{`${kind}:${id}`}</div>
  ),
}));

const DOC = 'doc-1111111111111-aaaaaaaaa';
const ARCHIVED_DOC = 'doc-1111111111111-bbbbbbbbb';
const PURGED_DOC = 'doc-1111111111111-ccccccccc';
const AGENT = 'test-agent-a';
const PROJECT = 'container-1111111111111-aaaaaaaaa';

const related: RelatedTableItems = {
  doc: {
    [DOC]: { title: 'Launch brief', archived: false },
    [ARCHIVED_DOC]: { title: 'Old brief', archived: true },
  },
  agent: { [AGENT]: { title: 'Test Agent A', archived: false } },
};

const field: TableField = {
  range: false,
  id: 'field-1111111111111-aaaaaaaaa',
  tableId: 'table-1111111111111-aaaaaaaaa',
  columnName: 'briefs',
  name: 'briefs',
  description: null,
  type: 'relation',
  nullable: false,
  defaultValue: [],
  referenceTableId: null,
  referenceKind: 'doc',
  position: 2,
  managed: false,
  collapsed: false,
  isTitle: false,
  multiple: true,
  options: null,
  revision: 1,
};

function show(children: ReactNode) {
  return render(
    <DashboardNavigationProvider
      value={{ openInPane: vi.fn(), openThreadAgent: vi.fn(), requestReveal: vi.fn() }}
    >
      {children}
    </DashboardNavigationProvider>
  );
}

beforeEach(() => __resetSnagletItemTitlesForTests());
afterEach(() => {
  cleanup();
  __resetSnagletItemTitlesForTests();
});

describe('Snaglet item relation cells', () => {
  it('renders live, archived and purged items in order', () => {
    show(
      <TableEntryValueView
        field={field}
        value={[DOC, ARCHIVED_DOC, PURGED_DOC]}
        relatedItems={related}
        interactive
      />
    );
    const [live, archived, purged] = screen.getAllByRole('link');
    expect(live).toHaveTextContent('Launch brief');
    expect(live).toHaveAttribute('href', DOC);
    expect(live).toHaveClass('md-chip-doc');
    expect(live).toHaveAttribute('draggable', 'true');
    expect(live).not.toHaveAttribute('title');

    expect(archived).toHaveTextContent('Old brief');
    expect(archived).toHaveClass('md-chip-archived');
    expect(archived).toHaveAttribute('title', 'This doc is archived');
    expect(archived).toHaveAttribute('draggable', 'false');

    expect(purged).toHaveTextContent('Unavailable');
    expect(purged).toHaveClass('md-chip-unavailable');
    expect(purged).toHaveAttribute('title', 'This doc no longer exists');
    expect(purged).toHaveAttribute('aria-disabled', 'true');
  });

  it('opens a live item through the usual chip preview, and a purged one never', () => {
    show(
      <>
        <SnagletReferenceChip kind="doc" id={DOC} relatedItems={related} />
        <SnagletReferenceChip kind="doc" id={PURGED_DOC} relatedItems={related} />
      </>
    );
    fireEvent.click(screen.getByText('Unavailable'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Launch brief'));
    expect(screen.getByRole('dialog', { name: 'Preview' })).toHaveTextContent(`page:${DOC}`);
  });

  it('opens agents and projects (as containers) by their own chip paths', () => {
    rememberItem('project', PROJECT, { title: 'Test Project', archived: false });
    show(
      <>
        <SnagletReferenceChip kind="agent" id={AGENT} relatedItems={related} />
        <SnagletReferenceChip kind="project" id={PROJECT} />
      </>
    );
    const agent = screen.getByText('Test Agent A').closest('a');
    expect(agent).toHaveAttribute('href', AGENT);
    expect(agent).toHaveClass('md-chip-agent');
    fireEvent.click(screen.getByText('Test Agent A'));
    expect(screen.getByRole('dialog')).toHaveTextContent(`agent:${AGENT}`);
    cleanup();
    show(<SnagletReferenceChip kind="project" id={PROJECT} />);
    expect(screen.getByText('Test Project').closest('a')).toHaveClass('md-chip-container');
    fireEvent.click(screen.getByText('Test Project'));
    expect(screen.getByRole('dialog')).toHaveTextContent(`container:${PROJECT}`);
  });

  it('names items picked this session until a page read names or forgets them', () => {
    rememberItem('doc', PURGED_DOC, { title: 'Just picked', archived: false });
    const view = show(<SnagletReferenceChip kind="doc" id={PURGED_DOC} relatedItems={related} />);
    expect(screen.getByRole('link')).toHaveTextContent('Just picked');
    const entry: TableEntry = {
      id: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-01-01T00:00:00.000000Z',
      revision: 'r',
      values: { [field.id]: [PURGED_DOC, DOC] },
    };
    // The page links to it but does not name it: it was purged.
    syncRelatedItems([field], [entry], related);
    view.rerender(
      <DashboardNavigationProvider
        value={{ openInPane: vi.fn(), openThreadAgent: vi.fn(), requestReveal: vi.fn() }}
      >
        <SnagletReferenceChip kind="doc" id={PURGED_DOC} relatedItems={related} />
      </DashboardNavigationProvider>
    );
    expect(screen.getByRole('link')).toHaveTextContent('Unavailable');
  });

  it('renders read-only chips inside another control without links', () => {
    show(<TableEntryValueView field={field} value={[DOC]} relatedItems={related} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('Launch brief').closest('.md-chip')).toHaveAttribute(
      'data-node-id',
      DOC
    );
  });
});
