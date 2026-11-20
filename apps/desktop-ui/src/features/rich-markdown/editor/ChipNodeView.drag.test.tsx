/**
 * Editor (TipTap) chips are drag sources, the same as sidebar rows and chips
 * in rendered markdown: a press must leave the native drag alone (opening the
 * preview on mousedown would cancel it), a plain click opens the preview, and
 * dragstart carries the chip payload every chip-aware drop target reads.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { NODE_CHIP_MIME } from '@desktop/utils/nodeChip';
import { ChipEditableInput } from './ChipEditableInput';

const DOC = 'doc-2222222222222-bbbbbbbbb';

beforeAll(() => {
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
});

function renderInput(value: string) {
  render(
    <DashboardNavigationProvider
      value={{ openInPane: vi.fn(), openThreadAgent: vi.fn(), requestReveal: vi.fn() }}
    >
      <ChipEditableInput value={value} onChange={vi.fn()} ariaLabel="Body" />
    </DashboardNavigationProvider>
  );
}

const chip = () => document.querySelector<HTMLElement>('.md-chip-doc');

/** jsdom has no DataTransfer: a store that behaves like one for setData/getData. */
function fakeDataTransfer() {
  const data = new Map<string, string>();
  return {
    data,
    types: [] as string[],
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    setData: (type: string, value: string) => {
      data.set(type, value);
    },
    getData: (type: string) => data.get(type) ?? '',
    clearData: () => data.clear(),
    setDragImage: () => undefined,
    files: [],
  };
}

describe('editor chips as drag sources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.agents.mockResolvedValue([]);
    api.list.mockResolvedValue({ tables: [] });
  });

  it('is draggable and a press neither opens the preview nor cancels the drag', async () => {
    renderInput(`[Target](${DOC})`);
    await screen.findByRole('textbox', { name: 'Body' });
    await waitFor(() => expect(chip()).not.toBeNull());
    expect(chip()).toHaveAttribute('draggable', 'true');
    // fireEvent returns false when a handler called preventDefault, which
    // is what stops the browser from starting a native drag.
    expect(fireEvent.mouseDown(chip()!)).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the preview on a plain click', async () => {
    renderInput(`[Target](${DOC})`);
    await screen.findByRole('textbox', { name: 'Body' });
    await waitFor(() => expect(chip()).not.toBeNull());
    fireEvent.mouseDown(chip()!);
    fireEvent.mouseUp(chip()!);
    fireEvent.click(chip()!);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('writes the chip payload on dragstart', async () => {
    renderInput(`[Target](${DOC})`);
    await screen.findByRole('textbox', { name: 'Body' });
    await waitFor(() => expect(chip()).not.toBeNull());
    const dataTransfer = fakeDataTransfer();
    // A real drag begins with a press on the chip.
    fireEvent.mouseDown(chip()!);
    fireEvent.dragStart(chip()!, { dataTransfer });
    const payload = JSON.parse(dataTransfer.getData(NODE_CHIP_MIME)) as {
      id: string;
      kind: string;
      title: string | null;
    };
    expect(payload).toMatchObject({ id: DOC, kind: 'doc', title: 'Target' });
  });

  it('writes the payload when the drag starts on the label text of a selected chip', async () => {
    renderInput(`[Target](${DOC})`);
    await screen.findByRole('textbox', { name: 'Body' });
    await waitFor(() => expect(chip()).not.toBeNull());
    const label = chip()?.querySelector('.md-chip-title')?.firstChild;
    expect(label?.nodeType).toBe(Node.TEXT_NODE);
    const dataTransfer = fakeDataTransfer();
    fireEvent.mouseDown(chip() as HTMLElement);
    fireEvent.dragStart(label as Node, { dataTransfer });
    expect(dataTransfer.getData(NODE_CHIP_MIME)).toContain(DOC);
  });
});
