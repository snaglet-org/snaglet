import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useRef, useState, type FC } from 'react';
import { createPortal } from 'react-dom';
import { DateInput } from '../controls/DateInput/DateInput';
import { Modal } from '../Modal/Modal';
import { Popover } from './Popover';
import { usePopover } from './usePopover';
import { useDismissable } from './useDismissable';

/** Mirrors the real ProjectView shape: trigger + inline settings surface. */
const Harness: FC<{ onOpenChange?: (open: boolean) => void }> = ({ onOpenChange }) => {
  const popover = usePopover({ onOpenChange });
  return (
    <div>
      <button {...popover.triggerProps}>
        {popover.open ? 'Hide container settings' : 'Container settings'}
      </button>
      <Popover open={popover.open} label="Container settings" {...popover.surfaceProps}>
        <button type="button">Inside action</button>
      </Popover>
      <button type="button">Outside control</button>
    </div>
  );
};

describe('Popover + usePopover', () => {
  it('starts closed, matching useDisclosure’s collapsed-by-default convention', () => {
    render(<Harness />);
    expect(screen.queryByRole('group', { name: 'Container settings' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Container settings' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('opens from the trigger and wires aria-expanded/aria-controls', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Container settings' }));

    const surface = screen.getByRole('group', { name: 'Container settings' });
    const trigger = screen.getByRole('button', { name: 'Hide container settings' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', surface.id);
  });

  // Without this, a dropdown such as ProjectView's feels broken.
  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Container settings' }));
    expect(screen.getByRole('group', { name: 'Container settings' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Container settings' })).not.toBeInTheDocument();
  });

  it('closes on an outside press', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Container settings' }));

    await user.click(screen.getByRole('button', { name: 'Outside control' }));
    expect(screen.queryByRole('group', { name: 'Container settings' })).not.toBeInTheDocument();
  });

  it('stays open when pressing inside the surface', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Container settings' }));

    await user.click(screen.getByRole('button', { name: 'Inside action' }));
    expect(screen.getByRole('group', { name: 'Container settings' })).toBeInTheDocument();
  });

  // The `mousedown` bug this primitive exists to kill: an outside-press
  // listener that fires before click must not dismiss AND re-toggle, or the
  // trigger appears dead on every second press.
  it('toggles exactly once per trigger press — no dismiss/reopen double-fire', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);

    const trigger = screen.getByRole('button', { name: 'Container settings' });
    await user.click(trigger);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    await user.click(screen.getByRole('button', { name: 'Hide container settings' }));
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole('group', { name: 'Container settings' })).not.toBeInTheDocument();
  });

  it('restores focus to the trigger after Escape', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Container settings' });
    await user.click(trigger);

    await user.click(screen.getByRole('button', { name: 'Inside action' }));
    await user.keyboard('{Escape}');

    expect(screen.getByRole('button', { name: 'Container settings' })).toHaveFocus();
  });

  it('renders role="dialog" with aria-modal=false for form surfaces', async () => {
    const user = userEvent.setup();
    const FormHarness: FC = () => {
      const popover = usePopover();
      return (
        <>
          <button {...popover.triggerProps}>Edit field</button>
          <Popover open={popover.open} label="Edit field" role="dialog" {...popover.surfaceProps}>
            <input aria-label="Field name" />
          </Popover>
        </>
      );
    };
    render(<FormHarness />);
    await user.click(screen.getByRole('button', { name: 'Edit field' }));

    const dialog = screen.getByRole('dialog', { name: 'Edit field' });
    expect(dialog).toHaveAttribute('aria-modal', 'false');
  });

  it('honors keepOpenSelector for descendants outside both trees', async () => {
    const user = userEvent.setup();
    const KeepOpenHarness: FC = () => {
      const popover = usePopover({ keepOpenSelector: '[data-keeps-open]' });
      return (
        <>
          <button {...popover.triggerProps}>Open</button>
          <Popover open={popover.open} label="Surface" {...popover.surfaceProps}>
            <span>body</span>
          </Popover>
          <div data-keeps-open>
            <button type="button">Suggestion</button>
          </div>
          <button type="button">Elsewhere</button>
        </>
      );
    };
    render(<KeepOpenHarness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));

    await user.click(screen.getByRole('button', { name: 'Suggestion' }));
    expect(screen.getByRole('group', { name: 'Surface' })).toBeInTheDocument();

    // The surface ref is wired for real: a genuine outside press still dismisses.
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('group', { name: 'Surface' })).not.toBeInTheDocument();
  });

  // Surfaces open Modals (e.g. confirmations) that portal to <body>, so by DOM
  // containment their buttons are "outside" the popover.
  it('treats a press on a portaled child as inside', async () => {
    const user = userEvent.setup();
    const Portaled: FC = () =>
      createPortal(<button type="button">Portaled action</button>, document.body);
    const PortalHarness: FC = () => {
      const popover = usePopover();
      return (
        <>
          <button {...popover.triggerProps}>Open</button>
          <Popover open={popover.open} label="Surface" {...popover.surfaceProps}>
            <Portaled />
          </Popover>
        </>
      );
    };
    render(<PortalHarness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));

    await user.click(screen.getByRole('button', { name: 'Portaled action' }));
    expect(screen.getByRole('group', { name: 'Surface' })).toBeInTheDocument();
  });

  it('never dismisses for a press inside any aria-modal dialog', async () => {
    const user = userEvent.setup();
    const ModalSiblingHarness: FC = () => {
      const popover = usePopover();
      return (
        <>
          <button {...popover.triggerProps}>Open</button>
          <Popover open={popover.open} label="Surface" {...popover.surfaceProps}>
            <span>body</span>
          </Popover>
          <div role="dialog" aria-modal="true" aria-label="Unrelated dialog">
            <button type="button">Modal action</button>
          </div>
        </>
      );
    };
    render(<ModalSiblingHarness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));

    await user.click(screen.getByRole('button', { name: 'Modal action' }));
    expect(screen.getByRole('group', { name: 'Surface' })).toBeInTheDocument();
  });

  it('a press elsewhere in the modal it lives in is outside', () => {
    const onDismiss = vi.fn();
    const InModal: FC = () => {
      const ref = useRef<HTMLDivElement>(null);
      const props = useDismissable({ open: true, onDismiss, surfaceRef: ref });
      return (
        <div role="dialog" aria-modal="true" aria-label="Row">
          <div ref={ref} {...props}>
            <button type="button">Editor</button>
          </div>
          <button type="button">Elsewhere in the modal</button>
        </div>
      );
    };
    render(<InModal />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Editor' }));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere in the modal' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a press elsewhere in the modal it was portaled out of is outside, and Escape is its', () => {
    const onDismiss = vi.fn();
    const onClose = vi.fn();
    const List: FC = () => {
      const ref = useRef<HTMLDivElement>(null);
      const props = useDismissable({ open: true, onDismiss, surfaceRef: ref });
      return createPortal(
        <div ref={ref} {...props}>
          <button type="button">Option</button>
        </div>,
        document.body
      );
    };
    const InModal: FC = () => {
      const [open, setOpen] = useState(false);
      return (
        <Modal onClose={onClose}>
          <Modal.Header>Edit</Modal.Header>
          <Modal.Body>
            <button type="button" onClick={() => setOpen(true)}>
              Field
            </button>
            {open && <List />}
          </Modal.Body>
        </Modal>
      );
    };
    render(<InModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Field' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Option' }));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Field' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Option' }), { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
  });

  // One Escape, one layer: the modal stacked above the popover closes first,
  // the next Escape closes the popover.
  it('yields Escape to a modal opened from inside it', async () => {
    const user = userEvent.setup();
    const Confirm: FC = () => {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Demote
          </button>
          {open && (
            <Modal onClose={() => setOpen(false)}>
              <Modal.Header>Confirm demotion</Modal.Header>
              <Modal.Body>
                <button type="button">Confirm</button>
              </Modal.Body>
            </Modal>
          )}
        </>
      );
    };
    const StackHarness: FC = () => {
      const popover = usePopover();
      return (
        <>
          <button {...popover.triggerProps}>Open</button>
          <Popover open={popover.open} label="Surface" {...popover.surfaceProps}>
            <Confirm />
          </Popover>
        </>
      );
    };
    render(<StackHarness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByRole('button', { name: 'Demote' }));
    await screen.findByRole('dialog', { name: 'Confirm demotion' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus());

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Confirm demotion' })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Surface' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Surface' })).not.toBeInTheDocument();
  });

  // WKWebView does not focus a clicked button, so the element recorded on open
  // is <body>; focus must still land somewhere sensible on close.
  it('falls back to the trigger when nothing useful was focused on open', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Container settings' });
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(trigger);
    expect(screen.getByRole('group', { name: 'Container settings' })).toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);

    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Container settings' })).toHaveFocus();
  });

  it('opts out of Escape when asked', async () => {
    const user = userEvent.setup();
    const StickyHarness: FC = () => {
      const popover = usePopover({ closeOnEscape: false });
      return (
        <>
          <button {...popover.triggerProps}>Open</button>
          <Popover open={popover.open} label="Sticky" {...popover.surfaceProps}>
            <span>body</span>
          </Popover>
        </>
      );
    };
    render(<StickyHarness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));

    await user.keyboard('{Escape}');
    expect(screen.getByRole('group', { name: 'Sticky' })).toBeInTheDocument();
  });

  it('is inert while closed — no listeners bound', async () => {
    const user = userEvent.setup();
    const addSpy = vi.spyOn(document, 'addEventListener');
    render(<Harness />);
    const boundWhileClosed = addSpy.mock.calls.filter(
      ([type]) => type === 'pointerdown' || type === 'keydown'
    );
    expect(boundWhileClosed).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Container settings' }));
    const boundWhileOpen = addSpy.mock.calls.filter(
      ([type]) => type === 'pointerdown' || type === 'keydown'
    );
    expect(boundWhileOpen.length).toBeGreaterThan(0);
    addSpy.mockRestore();
  });

  it('useDismissable is usable standalone for bespoke layouts', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const Bespoke: FC = () => {
      const surfaceRef = useRef<HTMLDivElement>(null);
      useDismissable({ open: true, onDismiss, surfaceRef });
      return (
        <div>
          <div ref={surfaceRef}>surface</div>
          <button type="button">elsewhere</button>
        </div>
      );
    };
    render(<Bespoke />);

    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('says whether Escape or an outside press dismissed it', () => {
    const onDismiss = vi.fn();
    const Bespoke: FC = () => {
      const surfaceRef = useRef<HTMLDivElement>(null);
      useDismissable({ open: true, onDismiss, surfaceRef });
      return <div ref={surfaceRef}>surface</div>;
    };
    render(<Bespoke />);

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.pointerDown(document.body);
    expect(onDismiss.mock.calls).toEqual([['escape'], ['outside']]);
  });

  it('in the capture phase, dismisses for a press whose handler stops propagation', () => {
    const onDismiss = vi.fn();
    const Bespoke: FC<{ capture: boolean }> = ({ capture }) => {
      const surfaceRef = useRef<HTMLDivElement>(null);
      useDismissable({ open: true, onDismiss, surfaceRef, capture });
      return (
        <div>
          <div ref={surfaceRef}>
            <button type="button">inside</button>
          </div>
          <button type="button" onPointerDown={(event) => event.stopPropagation()}>
            grid header
          </button>
        </div>
      );
    };
    const { rerender } = render(<Bespoke capture={false} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'grid header' }));
    expect(onDismiss).not.toHaveBeenCalled();

    rerender(<Bespoke capture />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'inside' }));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'grid header' }));
    expect(onDismiss).toHaveBeenCalledWith('outside');
  });

  it('hears outside presses in the capture phase by default', () => {
    const onDismiss = vi.fn();
    const Bespoke: FC = () => {
      const surfaceRef = useRef<HTMLDivElement>(null);
      useDismissable({ open: true, onDismiss, surfaceRef });
      return (
        <div>
          <div ref={surfaceRef}>surface</div>
          <button type="button" onPointerDown={(event) => event.stopPropagation()}>
            column toggle
          </button>
        </div>
      );
    };
    render(<Bespoke />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'column toggle' }));
    expect(onDismiss).toHaveBeenCalledWith('outside');
  });

  it('in the capture phase, a press inside content portaled from the surface is inside', () => {
    const onDismiss = vi.fn();
    const Bespoke: FC = () => {
      const surfaceRef = useRef<HTMLDivElement>(null);
      const props = useDismissable({ open: true, onDismiss, surfaceRef });
      return (
        <div ref={surfaceRef} {...props}>
          surface
          {createPortal(<button type="button">portaled option</button>, document.body)}
        </div>
      );
    };
    render(<Bespoke />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'portaled option' }));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onDismiss).toHaveBeenCalledWith('outside');
  });
});

/** A popover holding a date field, as the row popover and the field editors do. */
const WithDate: FC = () => {
  const popover = usePopover();
  const [date, setDate] = useState('2026-10-20');
  return (
    <div>
      <button {...popover.triggerProps}>Settings</button>
      <Popover open={popover.open} label="Settings" {...popover.surfaceProps}>
        <DateInput aria-label="Due" value={date} onChange={setDate} />
      </Popover>
      <button type="button">Outside control</button>
    </div>
  );
};

describe('useDismissable with a date picker open inside it', () => {
  const open = async () => {
    const user = userEvent.setup();
    render(<WithDate />);
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    return screen.getByRole('group', { name: 'Settings' });
  };
  const openPicker = () => {
    const field = screen.getByRole('combobox', { name: 'Due' });
    field.focus();
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    return screen.getByRole('dialog', { name: 'Choose date' });
  };
  const outside = () =>
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside control' }));

  it('one outside press closes the picker and the popover together', async () => {
    await open();
    openPicker();
    outside();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Choose date' })).not.toBeInTheDocument()
    );
    expect(screen.queryByRole('group', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('a press inside the portaled picker keeps the popover open', async () => {
    const surface = await open();
    const picker = openPicker();
    fireEvent.pointerDown(within(picker).getAllByRole('gridcell')[0]!);
    expect(surface).toBeInTheDocument();
  });

  it('Escape closes the picker first, then the popover', async () => {
    const surface = await open();
    openPicker();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Choose date' })).not.toBeInTheDocument()
    );
    expect(surface).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Settings' })).not.toBeInTheDocument()
    );
  });

  it('with no picker open, one outside press closes it as before', async () => {
    await open();
    expect(screen.queryByRole('dialog', { name: 'Choose date' })).not.toBeInTheDocument();
    outside();
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Settings' })).not.toBeInTheDocument()
    );
  });
});
