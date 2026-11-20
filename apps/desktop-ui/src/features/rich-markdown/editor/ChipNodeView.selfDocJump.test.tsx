/**
 * Editor (TipTap) doc chips with an anchor into the doc being edited: a click
 * scrolls there in place (a line focus request for that doc) instead of
 * opening the preview modal, the same contract the rendered chip keeps.
 */
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { docAnchorLabel, lineRefLabel } from '@snaglet/shared/utils';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({ agents: vi.fn(), list: vi.fn() }));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    agentsApi: { ...actual.agentsApi, list: api.agents },
    tablesApi: { ...actual.tablesApi, list: api.list },
  };
});

import { DashboardNavigationProvider } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { HostDocProvider } from '../lineLinks/hostDoc';
import { consumeDocLineFocus, useDocLineFocusRequest } from '../lineLinks/lineFocusStore';
import { ChipEditableInput } from './ChipEditableInput';

const HOST_DOC = 'doc-1111111111111-aaaaaaaaa';
const OTHER_DOC = 'doc-2222222222222-bbbbbbbbb';

beforeAll(() => {
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
});

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

function renderInDoc(value: string, hostDocId: string) {
  render(
    <DashboardNavigationProvider
      value={{ openInPane: vi.fn(), openThreadAgent: vi.fn(), requestReveal: vi.fn() }}
    >
      <HostDocProvider docId={hostDocId}>
        <ChipEditableInput value={value} onChange={vi.fn()} ariaLabel="Body" />
      </HostDocProvider>
      <FocusProbe docId={hostDocId} />
    </DashboardNavigationProvider>
  );
}

const chip = () => document.querySelector<HTMLElement>('.md-chip-doc');
const probe = () => screen.getByTestId('focus-probe');

describe('editor doc chips that point into the host doc', () => {
  beforeEach(() => {
    // The focus store is module state: drop a request a previous test left.
    const { result } = renderHook(() => useDocLineFocusRequest(HOST_DOC));
    if (result.current) consumeDocLineFocus(HOST_DOC, result.current.nonce);
    vi.clearAllMocks();
    api.agents.mockResolvedValue([]);
    api.list.mockResolvedValue({ tables: [] });
  });

  it('jumps to the heading in place instead of opening a preview', async () => {
    renderInDoc(`[Rate limits](${HOST_DOC}#h=rate-limits)`, HOST_DOC);
    await screen.findByRole('textbox', { name: 'Body' });
    await waitFor(() => expect(chip()).not.toBeNull());
    fireEvent.click(chip()!);
    // A heading lands near the top and flashes, as an outline jump does.
    expect(probe().textContent).toBe('§ rate-limits (jump)');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('still opens the preview for an anchored chip into another doc', async () => {
    renderInDoc(`[Rate limits](${OTHER_DOC}#h=rate-limits)`, HOST_DOC);
    await screen.findByRole('textbox', { name: 'Body' });
    await waitFor(() => expect(chip()).not.toBeNull());
    fireEvent.click(chip()!);
    expect(probe()).toHaveTextContent('none');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
