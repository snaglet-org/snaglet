/**
 * ChipPalette — the shared presentational chip row.
 * Pins: click calls onInsert; drag writes EDITOR_CHIP_MIME (never
 * PANE_ITEM_MIME); empty/heading rendering.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PANE_ITEM_MIME } from '@desktop/utils/paneDrag';
import { ChipPalette, type EditorChipDescriptor } from './ChipPalette';
import { EDITOR_CHIP_MIME } from './editorChip';

const chips: EditorChipDescriptor[] = [
  { key: 'a', label: 'Agent one', insertText: "'agent-1'" },
  { key: 'b', label: 'Agent two', insertText: "'agent-2'" },
];

/** Minimal DataTransfer stand-in — jsdom has no native DataTransfer; matches
 *  ArchiveDropZone.test.tsx's established pattern in this repo. */
function makeDataTransfer() {
  const store = new Map<string, string>();
  return {
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? '',
    get types() {
      return [...store.keys()];
    },
    effectAllowed: '',
  };
}

describe('ChipPalette', () => {
  it('renders nothing when empty and no emptyText is given', () => {
    const { container } = render(<ChipPalette chips={[]} onInsert={() => undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders emptyText when chips is empty and emptyText is given', () => {
    render(<ChipPalette chips={[]} onInsert={() => undefined} emptyText="Nothing yet" />);
    expect(screen.getByText('Nothing yet')).toBeInTheDocument();
  });

  it('renders a heading and one pill per chip', () => {
    render(<ChipPalette heading="Agents" chips={chips} onInsert={() => undefined} />);
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByText('Agent one')).toBeInTheDocument();
    expect(screen.getByText('Agent two')).toBeInTheDocument();
  });

  it('clicking a chip calls onInsert with that chip', async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(<ChipPalette chips={chips} onInsert={onInsert} />);
    await user.click(screen.getByText('Agent one'));
    expect(onInsert).toHaveBeenCalledWith(chips[0]);
  });

  it('dragging a chip writes EDITOR_CHIP_MIME with the insertText, and never PANE_ITEM_MIME', () => {
    render(<ChipPalette chips={chips} onInsert={() => undefined} />);
    const dt = makeDataTransfer();
    const pill = screen.getByText('Agent one');
    // The draggable wrapper is the pill's parent span.
    fireEvent.dragStart(pill.closest('[draggable]') as Element, { dataTransfer: dt });
    expect(JSON.parse(dt.getData(EDITOR_CHIP_MIME)).text).toBe("'agent-1'");
    expect(dt.types).not.toContain(PANE_ITEM_MIME);
  });
});
