/**
 * Rendered doc chips with a line or heading anchor: inside the doc they point
 * at, a click scrolls there in place (a line focus request for that doc)
 * instead of opening the preview modal; anywhere else the modal still opens.
 * A heading lands near the top and flashes, as an outline jump does; lines
 * stay highlighted.
 */
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { docAnchorLabel, lineRefLabel } from '@snaglet/shared/utils';
import { DashboardNavigationProvider } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { HostDocProvider } from '../lineLinks/hostDoc';
import { consumeDocLineFocus, useDocLineFocusRequest } from '../lineLinks/lineFocusStore';
import { MarkdownRenderer } from './MarkdownRenderer';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({ agents: vi.fn(), list: vi.fn(), archived: vi.fn() }));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    agentsApi: { ...actual.agentsApi, list: api.agents },
    tablesApi: { ...actual.tablesApi, list: api.list },
    archiveApi: { ...actual.archiveApi, tables: api.archived },
  };
});

const HOST_DOC = 'doc-1111111111111-aaaaaaaaa';
const OTHER_DOC = 'doc-2222222222222-bbbbbbbbb';

/** Shows the pending line focus for a doc, the way DocView consumes it. */
function FocusProbe({ docId }: { docId: string }) {
  const request = useDocLineFocusRequest(docId);
  return (
    <output data-testid="focus-probe">
      {request
        ? `${docAnchorLabel(request.anchor, lineRefLabel)}${request.jump ? ' (jump)' : ''}`
        : 'none'}
    </output>
  );
}

function renderInDoc(content: string, hostDocId: string) {
  render(
    <DashboardNavigationProvider
      value={{ openInPane: vi.fn(), openThreadAgent: vi.fn(), requestReveal: vi.fn() }}
    >
      <HostDocProvider docId={hostDocId}>
        <MarkdownRenderer content={content} />
      </HostDocProvider>
      <FocusProbe docId={hostDocId} />
    </DashboardNavigationProvider>
  );
}

const chip = () => document.querySelector<HTMLAnchorElement>('a.md-chip-doc');
const probe = () => screen.getByTestId('focus-probe');

describe('rendered doc chips that point into the host doc', () => {
  beforeEach(() => {
    // The focus store is module state: drop a request a previous test left.
    const { result } = renderHook(() => useDocLineFocusRequest(HOST_DOC));
    if (result.current) consumeDocLineFocus(HOST_DOC, result.current.nonce);
    vi.clearAllMocks();
    api.agents.mockResolvedValue([]);
    api.list.mockResolvedValue({ tables: [] });
    api.archived.mockResolvedValue({ tables: [] });
  });

  it('jumps to the heading in place instead of opening a preview', async () => {
    renderInDoc(`See [Rate limits](${HOST_DOC}#h=rate-limits).`, HOST_DOC);
    await waitFor(() => expect(chip()).not.toBeNull());
    fireEvent.click(chip()!);
    expect(probe().textContent).toBe('§ rate-limits (jump)');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('jumps to the lines in place, highlighting them', async () => {
    renderInDoc(`See [the setup](${HOST_DOC}#L12-L20).`, HOST_DOC);
    await waitFor(() => expect(chip()).not.toBeNull());
    fireEvent.click(chip()!);
    expect(probe().textContent).toBe(lineRefLabel({ startLine: 12, endLine: 20 }));
  });

  it('still opens the preview for an anchored chip into another doc', async () => {
    renderInDoc(`See [Rate limits](${OTHER_DOC}#h=rate-limits).`, HOST_DOC);
    await waitFor(() => expect(chip()).not.toBeNull());
    fireEvent.click(chip()!);
    expect(probe()).toHaveTextContent('none');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('still opens the preview for a same-doc chip without an anchor', async () => {
    renderInDoc(`See [this doc](${HOST_DOC}).`, HOST_DOC);
    await waitFor(() => expect(chip()).not.toBeNull());
    fireEvent.click(chip()!);
    expect(probe()).toHaveTextContent('none');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
