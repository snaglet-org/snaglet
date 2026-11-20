import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState, type FC } from 'react';
import { createPortal } from 'react-dom';
import { describe, expect, it, vi } from 'vitest';
import { useDismissable } from '../Popover/useDismissable';
import { Modal } from './Modal';

function ModalHarness() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open review
      </button>
      {open && (
        <Modal onClose={() => setOpen(false)}>
          <Modal.Header>Review changes</Modal.Header>
          <Modal.Body>
            <button type="button">First action</button>
            <input aria-label="Review note" />
          </Modal.Body>
          <Modal.Footer>
            <button type="button">Last action</button>
          </Modal.Footer>
        </Modal>
      )}
    </>
  );
}

describe('Modal accessibility contract', () => {
  it('opens as a named dialog and moves focus to its first action', async () => {
    const user = userEvent.setup();
    render(<ModalHarness />);

    await user.click(screen.getByRole('button', { name: 'Open review' }));

    expect(screen.getByRole('dialog', { name: 'Review changes' })).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First action' }));
    });
  });

  it('contains Tab focus in both directions', async () => {
    const user = userEvent.setup();
    render(<ModalHarness />);
    await user.click(screen.getByRole('button', { name: 'Open review' }));

    const first = screen.getByRole('button', { name: 'First action' });
    const last = screen.getByRole('button', { name: 'Last action' });
    await waitFor(() => expect(document.activeElement).toBe(first));

    last.focus();
    await user.tab();
    expect(document.activeElement).toBe(first);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
  });

  it('closes on Escape and restores focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<ModalHarness />);
    const trigger = screen.getByRole('button', { name: 'Open review' });
    await user.click(trigger);
    await screen.findByRole('dialog', { name: 'Review changes' });

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('leaves an Escape a nested control already handled alone', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal onClose={onClose}>
        <Modal.Header>Edit</Modal.Header>
        <Modal.Body>
          <input
            aria-label="Inline editor"
            onKeyDown={(event) => {
              if (event.key === 'Escape') event.preventDefault();
            }}
          />
        </Modal.Body>
      </Modal>
    );
    const input = screen.getByRole('textbox', { name: 'Inline editor' });
    await waitFor(() => expect(input).toHaveFocus());

    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Edit' })).toBeInTheDocument();
  });

  it('closes only the dialog on top on Escape, whichever listens first', async () => {
    const user = userEvent.setup();
    const onOuterClose = vi.fn();
    const Stack: FC<{ outerKey: number }> = ({ outerKey }) => {
      const [inner, setInner] = useState(false);
      return (
        // A new onClose each render re-registers the outer listener after the inner one.
        <Modal onClose={() => onOuterClose(outerKey)} aria-label="Outer">
          <button type="button" onClick={() => setInner(true)}>
            Open inner
          </button>
          {inner && (
            <Modal onClose={() => setInner(false)} aria-label="Inner">
              <button type="button">Inner action</button>
            </Modal>
          )}
        </Modal>
      );
    };
    const { rerender } = render(<Stack outerKey={1} />);
    await user.click(screen.getByRole('button', { name: 'Open inner' }));
    rerender(<Stack outerKey={2} />);
    await act(async () => Promise.resolve());

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Inner' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Outer' })).toBeInTheDocument();
    expect(onOuterClose).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(onOuterClose).toHaveBeenCalledTimes(1);
  });

  // One press, one layer: the list closes, unsaved; the next press closes the dialog.
  it('a backdrop press while a floating layer is open over it closes only that layer', () => {
    const onClose = vi.fn();
    const List: FC<{ onDismiss: () => void }> = ({ onDismiss }) => {
      const ref = useRef<HTMLDivElement>(null);
      const props = useDismissable({ open: true, onDismiss, surfaceRef: ref });
      return createPortal(
        <div ref={ref} role="listbox" aria-label="Choices" data-floating-layer="" {...props} />,
        document.body
      );
    };
    const Picker: FC = () => {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Pick
          </button>
          {open && <List onDismiss={() => setOpen(false)} />}
        </>
      );
    };
    render(
      <Modal onClose={onClose}>
        <Modal.Header>Edit</Modal.Header>
        <Modal.Body>
          <Picker />
        </Modal.Body>
      </Modal>
    );
    const backdrop = screen.getByRole('dialog', { name: 'Edit' }).parentElement!;
    const press = () => {
      fireEvent.pointerDown(backdrop);
      fireEvent.click(backdrop);
    };

    fireEvent.click(screen.getByRole('button', { name: 'Pick' }));
    expect(screen.getByRole('listbox', { name: 'Choices' })).toBeInTheDocument();
    press();
    expect(screen.queryByRole('listbox', { name: 'Choices' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    press();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
