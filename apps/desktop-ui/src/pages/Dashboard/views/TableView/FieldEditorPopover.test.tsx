import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createPortal } from 'react-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldEditorPopover } from './FieldEditorPopover';

afterEach(() => vi.restoreAllMocks());

function mount(anchorRect: DOMRect, paneRect?: DOMRect) {
  render(
    <div className={paneRect ? 'pane-body' : undefined}>
      <button type="button">Edit field</button>
    </div>
  );
  const anchor = screen.getByRole('button', { name: 'Edit field' });
  const anchorBounds = vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(anchorRect);
  if (paneRect && anchor.parentElement) {
    vi.spyOn(anchor.parentElement, 'getBoundingClientRect').mockReturnValue(paneRect);
  }
  const view = render(
    <FieldEditorPopover
      id="field-editor"
      label="Field settings: Summary"
      anchor={anchor}
      onRequestClose={vi.fn()}
    >
      <section aria-label="Field settings">Form content</section>
    </FieldEditorPopover>
  );
  const popover = screen.getByRole('region', { name: 'Field settings' }).parentElement;
  if (!popover) throw new Error('Missing anchored field editor');
  return { ...view, anchorBounds, popover };
}

describe('FieldEditorPopover', () => {
  it('mounts autofocus controls only after their host has connected anchor geometry', () => {
    const anchor = document.createElement('button');
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 100, 30));
    render(
      <FieldEditorPopover
        id="field-editor"
        label="New field"
        anchor={anchor}
        onRequestClose={vi.fn()}
      >
        <input aria-label="Field name" autoFocus />
      </FieldEditorPopover>
    );
    expect(screen.queryByRole('textbox', { name: 'Field name' })).not.toBeInTheDocument();
    document.body.append(anchor);
    fireEvent.resize(window);
    expect(screen.getByRole('textbox', { name: 'Field name' })).toHaveFocus();
    expect(screen.getByRole('textbox').parentElement).not.toHaveStyle({ visibility: 'hidden' });
    anchor.remove();
  });

  it('aligns below the header and clamps the dropdown to its pane, not the full window', () => {
    // A 500px pane: the surface may be as tall as the pane (inset 8 each side).
    const { popover } = mount(new DOMRect(950, 110, 30, 30), new DOMRect(700, 80, 280, 500));
    expect(popover).toHaveStyle({
      left: '708px',
      top: '144px',
      width: '264px',
      maxHeight: '484px',
    });
  });

  it('moves with the anchor during horizontal scrolling without discarding form content', () => {
    const { anchorBounds, popover } = mount(new DOMRect(150, 100, 180, 30));
    expect(popover).toHaveStyle({ left: '150px', top: '134px', width: '320px' });
    anchorBounds.mockReturnValue(new DOMRect(-40, 100, 180, 30));
    fireEvent.scroll(window);
    expect(popover).toHaveStyle({ left: '8px' });
    expect(screen.getByText('Form content')).toBeInTheDocument();
  });

  it('slides up over a low anchor when it fits neither below nor above', () => {
    const { popover } = mount(new DOMRect(100, 300, 100, 20));
    Object.defineProperty(popover, 'scrollHeight', { configurable: true, value: 500 });
    fireEvent.resize(window);
    // 768px window: 440 below, 288 above; the 500px card ends at the bottom inset.
    expect(popover).toHaveStyle({ top: '260px', maxHeight: '560px' });
  });

  it('opens above a low header and uses actual content height when it is shorter than the limit', () => {
    const { popover } = mount(new DOMRect(100, 730, 100, 20));
    Object.defineProperty(popover, 'scrollHeight', { configurable: true, value: 120 });
    fireEvent.resize(window);
    expect(popover).toHaveStyle({ top: '606px', maxHeight: '560px' });
  });

  it('retains its last connected geometry until a replacement anchor is available', () => {
    const { popover, rerender } = mount(new DOMRect(360, 100, 180, 30));
    const anchor = screen.getByRole('button', { name: 'Edit field' });
    let replacement: HTMLElement | null = null;
    rerender(
      <FieldEditorPopover
        id="field-editor"
        label="Field settings: Summary"
        anchor={anchor}
        resolveAnchor={() => replacement}
        onRequestClose={vi.fn()}
      >
        <section aria-label="Field settings">Form content</section>
      </FieldEditorPopover>
    );
    anchor.remove();
    fireEvent.resize(window);
    fireEvent.scroll(window);
    expect(popover).toHaveStyle({ left: '360px', top: '134px' });
    render(<button type="button">Replacement field</button>);
    replacement = screen.getByRole('button', { name: 'Replacement field' });
    vi.spyOn(replacement, 'getBoundingClientRect').mockReturnValue(new DOMRect(440, 100, 180, 30));
    fireEvent.resize(window);
    expect(popover).toHaveStyle({ left: '440px', top: '134px' });
  });

  it('names a non-modal dialog and wraps Tab between the first input and Close', async () => {
    render(<button type="button">Anchor</button>);
    const anchor = screen.getByRole('button', { name: 'Anchor' });
    render(
      <FieldEditorPopover
        id="field-editor"
        label="Field settings: Summary"
        anchor={anchor}
        onRequestClose={vi.fn()}
      >
        <input aria-label="Field name" autoFocus />
        <button type="button" disabled>
          Unavailable
        </button>
        <button type="button">Close</button>
      </FieldEditorPopover>
    );
    const dialog = screen.getByRole('dialog', { name: 'Field settings: Summary' });
    expect(dialog).toHaveAttribute('id', 'field-editor');
    expect(dialog).toHaveAttribute('aria-modal', 'false');
    const input = screen.getByRole('textbox', { name: 'Field name' });
    const close = screen.getByRole('button', { name: 'Close' });
    await userEvent.tab({ shift: true });
    expect(close).toHaveFocus();
    await userEvent.tab();
    expect(input).toHaveFocus();
    await userEvent.tab();
    expect(close).toHaveFocus();
  });

  it('handles Escape from the document but respects a child that already handled it', () => {
    render(<button type="button">Anchor</button>);
    const anchor = screen.getByRole('button', { name: 'Anchor' });
    const onRequestClose = vi.fn();
    const view = render(
      <FieldEditorPopover
        id="field-editor"
        label="New field"
        anchor={anchor}
        onRequestClose={onRequestClose}
      >
        <input aria-label="Field name" onKeyDown={(event) => event.preventDefault()} />
      </FieldEditorPopover>
    );
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(false);
    expect(onRequestClose).toHaveBeenCalledTimes(1);
    view.unmount();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it('owns outside dismissal without a focus-return prop and preserves suggestions and chip browsing', () => {
    render(
      <>
        <button type="button">Anchor</button>
        <button type="button" data-keeps-cell="">
          Browse chips
        </button>
        <button type="button">Outside</button>
      </>
    );
    const anchor = screen.getByRole('button', { name: 'Anchor' });
    const onRequestClose = vi.fn();
    render(
      <FieldEditorPopover
        id="field-editor"
        label="New field"
        anchor={anchor}
        onRequestClose={onRequestClose}
      >
        <input aria-label="Field name" />
        {createPortal(<button type="button">Chip suggestion</button>, document.body)}
      </FieldEditorPopover>
    );
    for (const name of ['Anchor', 'Browse chips', 'Chip suggestion']) {
      fireEvent.pointerDown(screen.getByRole('button', { name }));
    }
    fireEvent.pointerDown(screen.getByRole('dialog'));
    expect(onRequestClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a press outside whose own handler stops it (a column header control)', () => {
    render(
      <>
        <button type="button">Edit field due</button>
        <button type="button" onPointerDown={(event) => event.stopPropagation()}>
          Hide field id
        </button>
      </>
    );
    const onRequestClose = vi.fn();
    render(
      <FieldEditorPopover
        id="field-editor"
        label="Field settings"
        anchor={screen.getByRole('button', { name: 'Edit field due' })}
        onRequestClose={onRequestClose}
      >
        <input aria-label="Field name" />
      </FieldEditorPopover>
    );
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Hide field id' }));
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it('a press in a select list portaled from the form keeps it open; the next press outside closes it', () => {
    render(<button type="button">Edit field due</button>);
    const onRequestClose = vi.fn();
    render(
      <FieldEditorPopover
        id="field-editor"
        label="Field settings"
        anchor={screen.getByRole('button', { name: 'Edit field due' })}
        onRequestClose={onRequestClose}
      >
        <input aria-label="Field name" />
        {createPortal(
          <div role="listbox" aria-label="Calendar">
            <div role="option" aria-selected="false">
              Agenda
            </div>
          </div>,
          document.body
        )}
      </FieldEditorPopover>
    );
    fireEvent.pointerDown(screen.getByRole('option', { name: 'Agenda' }));
    expect(onRequestClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes it', () => {
    render(<button type="button">Edit field due</button>);
    const onRequestClose = vi.fn();
    render(
      <FieldEditorPopover
        id="field-editor"
        label="Field settings"
        anchor={screen.getByRole('button', { name: 'Edit field due' })}
        onRequestClose={onRequestClose}
      >
        <input aria-label="Field name" />
      </FieldEditorPopover>
    );
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Field name' }), { key: 'Escape' });
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it('reanchors to a replacement header after a schema commit without scroll or resize', async () => {
    const { popover, rerender } = mount(
      new DOMRect(150, 100, 100, 30),
      new DOMRect(0, 0, 900, 700)
    );
    const anchor = screen.getByRole('button', { name: 'Edit field' });
    const pane = anchor.parentElement;
    if (!pane) throw new Error('Missing pane');
    let replacement: HTMLElement | null = null;
    rerender(
      <FieldEditorPopover
        id="field-editor"
        label="New field"
        anchor={anchor}
        resolveAnchor={() => replacement}
        onRequestClose={vi.fn()}
      >
        <section aria-label="Field settings">Form content</section>
      </FieldEditorPopover>
    );
    replacement = document.createElement('button');
    vi.spyOn(replacement, 'getBoundingClientRect').mockReturnValue(new DOMRect(410, 100, 100, 30));
    pane.append(replacement);
    anchor.remove();
    await waitFor(() => expect(popover).toHaveStyle({ left: '410px', top: '134px' }));
  });
});
