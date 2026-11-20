import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PANE_ITEM_MIME } from '@desktop/utils/paneDrag';
import { TreeRow } from './SidebarTree';

function dataTransfer(existing = '') {
  const values = new Map<string, string>();
  if (existing) values.set(PANE_ITEM_MIME, existing);
  return {
    effectAllowed: 'none',
    getData: vi.fn((type: string) => values.get(type) ?? ''),
    setData: vi.fn((type: string, value: string) => values.set(type, value)),
  };
}

describe('desktop SidebarTree adapter', () => {
  it('adds the pane payload and preserves the consumer drag handler', () => {
    const onDragStart = vi.fn();
    const transfer = dataTransfer();
    const selection = { kind: 'doc' as const, doc_id: 'doc-1' };
    render(<TreeRow label="Search notes" paneSelection={selection} onDragStart={onDragStart} />);

    const row = screen.getByRole('button', { name: 'Search notes' });
    expect(row).toHaveAttribute('draggable', 'true');
    fireEvent.dragStart(row, { dataTransfer: transfer });

    expect(transfer.setData).toHaveBeenCalledWith(PANE_ITEM_MIME, JSON.stringify(selection));
    expect(transfer.effectAllowed).toBe('all');
    expect(onDragStart).toHaveBeenCalledOnce();
  });

  it('does not overwrite a pane payload supplied by a richer drag source', () => {
    const transfer = dataTransfer('existing-payload');
    render(<TreeRow label="Existing payload" paneSelection={{ kind: 'doc', doc_id: 'doc-2' }} />);

    fireEvent.dragStart(screen.getByRole('button', { name: 'Existing payload' }), {
      dataTransfer: transfer,
    });

    expect(transfer.setData).not.toHaveBeenCalled();
    expect(transfer.effectAllowed).toBe('none');
  });
});
