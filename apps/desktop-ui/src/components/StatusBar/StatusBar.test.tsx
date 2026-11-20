import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useEffect, type FC } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusBar } from './StatusBar';
import { StatusBarProvider, useStatusBar, useStatusBarSlot } from './StatusBarContext';
import type { StatusBarSlot } from './types';
import { MAX_ZOOM, MIN_ZOOM, setZoom } from './consumers/zoomWindow';

/** Registers a fixed slot for the lifetime of the mounted component. */
const SlotConsumer: FC<{ slot: StatusBarSlot }> = ({ slot }) => {
  useStatusBarSlot(slot);
  return null;
};

/**
 * jsdom lays nothing out: give the popover with `role` a content height in
 * its own CSS px (what placement reads, even while the popover is capped).
 */
function stubContentHeight(role: string, height: () => number): void {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.getAttribute('role') === role ? height() : 0;
  });
}

const toggleSlot = (id: string): StatusBarSlot => ({
  id,
  zone: 'left',
  item: { type: 'toggle', label: 'Options', render: () => <button>Save</button> },
});

const menuSlot = (select: (id: string) => void = () => {}): StatusBarSlot => ({
  id: 'menu',
  zone: 'right',
  item: {
    type: 'menu',
    label: 'Actions',
    actions: [
      { id: 'first', label: 'First action', onSelect: () => select('first') },
      { id: 'off', label: 'Unavailable', onSelect: () => select('off'), disabled: true },
      { id: 'last', label: 'Last action', onSelect: () => select('last') },
    ],
  },
});

const renderToggle = () =>
  render(
    <StatusBarProvider>
      <SlotConsumer slot={toggleSlot('toggle')} />
      <StatusBar />
    </StatusBarProvider>
  );

describe('StatusBar', () => {
  it('renders registered slots in their zones and drops them on unmount', () => {
    const slot: StatusBarSlot = {
      id: 'left-1',
      zone: 'left',
      item: { type: 'text', label: 'Connected' },
    };
    const { rerender } = render(
      <StatusBarProvider>
        <SlotConsumer slot={slot} />
        <StatusBar />
      </StatusBarProvider>
    );
    const left = screen.getByLabelText('Status bar').querySelector('[data-zone="left"]');
    expect(left).toHaveTextContent('Connected');

    // Same provider (store persists across rerender); dropping the consumer
    // runs its cleanup, which unregisters the slot from the live store.
    rerender(
      <StatusBarProvider>
        <StatusBar />
      </StatusBarProvider>
    );
    expect(screen.getByLabelText('Status bar')).not.toHaveTextContent('Connected');
  });

  it('opens a toggle popover ABOVE the bar and closes it on Escape', () => {
    const slot: StatusBarSlot = {
      id: 'toggle-1',
      zone: 'right',
      item: {
        type: 'toggle',
        label: 'Settings',
        render: () => <div>Popover body</div>,
      },
    };
    render(
      <StatusBarProvider>
        <SlotConsumer slot={slot} />
        <StatusBar />
      </StatusBarProvider>
    );

    expect(screen.queryByText('Popover body')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Popover body');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Popover body')).toBeNull();
  });

  it('places the popover fixed above its trigger so the scrolling bar cannot clip it', () => {
    const slot: StatusBarSlot = {
      id: 'toggle-pos',
      zone: 'right',
      item: { type: 'toggle', label: 'Workers', render: () => <div>Body</div> },
    };
    render(
      <StatusBarProvider>
        <SlotConsumer slot={slot} />
        <StatusBar />
      </StatusBarProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: /workers/i }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.style.top).not.toBe('');
    expect(dialog.style.left).not.toBe('');
  });

  it.each([MIN_ZOOM, 0.9, 1, 1.1, 1.25, 1.5, 1.75, MAX_ZOOM])(
    'keeps every menu button in the window at zoom %s',
    (zoom) => {
      setZoom(zoom);
      const viewport = { width: 1000, height: 800 };
      const anchor = { left: 800, top: 760, right: 900, bottom: 784 };
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement
      ) {
        const probe = this.dataset.fixedLayerProbe;
        if (probe === 'unit')
          return DOMRect.fromRect({
            x: 100 * zoom,
            y: 100 * zoom,
            width: 100 * zoom,
            height: 100 * zoom,
          });
        if (probe === 'viewport') return DOMRect.fromRect(viewport);
        if (this.getAttribute('role') === 'menu')
          return DOMRect.fromRect({ width: 240 * zoom, height: 180 * zoom });
        return DOMRect.fromRect({
          x: anchor.left,
          y: anchor.top,
          width: anchor.right - anchor.left,
          height: anchor.bottom - anchor.top,
        });
      });
      stubContentHeight('menu', () => 180);
      const select = vi.fn();
      const slot: StatusBarSlot = {
        id: 'zoom-menu',
        zone: 'right',
        item: {
          type: 'menu',
          label: 'Actions',
          actions: [
            { id: 'first', label: 'First action', onSelect: select },
            { id: 'last', label: 'Last action', onSelect: select },
          ],
        },
      };
      render(
        <StatusBarProvider>
          <SlotConsumer slot={slot} />
          <StatusBar />
        </StatusBarProvider>
      );
      fireEvent.click(screen.getByRole('button', { name: /actions/i }));
      const menu = screen.getByRole('menu');
      expect(menu.parentElement).toBe(document.body);
      expect(Number.parseFloat(menu.style.left) * zoom + 240 * zoom).toBeCloseTo(anchor.right);
      expect(Number.parseFloat(menu.style.top) * zoom + 180 * zoom).toBeCloseTo(
        anchor.top - 4 * zoom
      );
      expect(Number.parseFloat(menu.style.left) * zoom).toBeGreaterThanOrEqual(0);
      expect(Number.parseFloat(menu.style.top) * zoom).toBeGreaterThanOrEqual(0);
      expect(screen.getAllByRole('menuitem')).toHaveLength(2);
      fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Last action' }));
      expect(screen.getByRole('menu')).toBe(menu);
      fireEvent.click(screen.getByRole('menuitem', { name: 'Last action' }));
      expect(select).toHaveBeenCalledOnce();
      expect(screen.queryByRole('menu')).toBeNull();
    }
  );

  it('repositions an open toggle on zoom, resize, scroll and content resize', () => {
    let resize: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }
        observe() {}
        disconnect() {}
      }
    );
    let top = 20;
    let height = 100;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.dataset.fixedLayerProbe) return DOMRect.fromRect({});
      if (this.getAttribute('role') === 'dialog') return DOMRect.fromRect({ width: 200, height });
      return DOMRect.fromRect({ x: 10, y: top, width: 80, height: 24 });
    });
    stubContentHeight('dialog', () => height);
    const slot: StatusBarSlot = {
      id: 'moving-toggle',
      zone: 'left',
      item: {
        type: 'toggle',
        label: 'Options',
        render: () => <button>Save</button>,
      },
    };
    render(
      <StatusBarProvider>
        <SlotConsumer slot={slot} />
        <StatusBar />
      </StatusBarProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: /options/i }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.style.top).toBe('48px'); // Flip below when there is no room above.
    top = 700;
    act(() => setZoom(MAX_ZOOM)); // Identity probe models older WebKit rect coordinates.
    expect(dialog.style.top).toBe('596px');
    height = 150;
    act(() => resize?.([], {} as ResizeObserver));
    expect(dialog.style.top).toBe('546px');
    top = 680;
    fireEvent.resize(window);
    expect(dialog.style.top).toBe('526px');
    top = 660;
    fireEvent.scroll(window);
    expect(dialog.style.top).toBe('506px');
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('dialog')).toBe(dialog);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each(['left', 'right'] as const)('slides a %s-zone popover away from window edges', (zone) => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.dataset.fixedLayerProbe) return DOMRect.fromRect({});
      if (this.getAttribute('role') === 'dialog')
        return DOMRect.fromRect({ width: 200, height: 100 });
      return DOMRect.fromRect({
        x: zone === 'left' ? window.innerWidth - 40 : 0,
        y: 700,
        width: 40,
        height: 24,
      });
    });
    stubContentHeight('dialog', () => 100);
    const slot: StatusBarSlot = {
      id: 'edge-toggle',
      zone,
      item: {
        type: 'toggle',
        label: 'Options',
        render: () => <button>Save</button>,
      },
    };
    render(
      <StatusBarProvider>
        <SlotConsumer slot={slot} />
        <StatusBar />
      </StatusBarProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: /options/i }));
    const left = Number.parseFloat(screen.getByRole('dialog').style.left);
    expect(left).toBeGreaterThanOrEqual(4);
    expect(left + 200).toBeLessThanOrEqual(window.innerWidth - 4);
  });

  it('caps a popover taller than the window at the window, so it scrolls instead of being cut off', () => {
    stubContentHeight('dialog', () => 2000);
    render(
      <StatusBarProvider>
        <SlotConsumer slot={toggleSlot('tall')} />
        <StatusBar />
      </StatusBarProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Options' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.style.maxHeight).toBe(`${window.innerHeight - 2 * 4}px`);
    expect(dialog.style.top).toBe('4px');
  });

  it('names each popover after its trigger and says what kind of popup the trigger opens', () => {
    render(
      <StatusBarProvider>
        <SlotConsumer slot={toggleSlot('named-toggle')} />
        <SlotConsumer slot={menuSlot()} />
        <StatusBar />
      </StatusBarProvider>
    );
    const toggle = screen.getByRole('button', { name: 'Options' });
    const menuTrigger = screen.getByRole('button', { name: 'Actions' });
    expect(toggle).toHaveAttribute('aria-haspopup', 'dialog');
    expect(menuTrigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(toggle).not.toHaveAttribute('aria-controls');

    fireEvent.click(toggle);
    const dialog = screen.getByRole('dialog', { name: 'Options' });
    expect(toggle).toHaveAttribute('aria-controls', dialog.id);
    fireEvent.click(toggle);
    fireEvent.click(menuTrigger);
    expect(menuTrigger).toHaveAttribute(
      'aria-controls',
      screen.getByRole('menu', { name: 'Actions' }).id
    );
  });

  it('returns focus to the trigger after Escape', () => {
    renderToggle();
    const trigger = screen.getByRole('button', { name: 'Options' });
    fireEvent.click(trigger, { detail: 1 });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('leaves focus where an outside press put it', () => {
    render(
      <StatusBarProvider>
        <SlotConsumer slot={toggleSlot('outside-focus')} />
        <StatusBar />
        <input aria-label="Composer" />
      </StatusBarProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Options' }));
    expect(screen.getByRole('dialog')).toHaveFocus();
    const composer = screen.getByRole('textbox', { name: 'Composer' });
    fireEvent.pointerDown(composer);
    composer.focus();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(composer).toHaveFocus();
  });

  it('moves focus into a popover opened from the keyboard, not one opened with the mouse', () => {
    renderToggle();
    const trigger = screen.getByRole('button', { name: 'Options' });
    fireEvent.click(trigger, { detail: 1 });
    expect(screen.getByRole('dialog')).not.toHaveFocus();
    fireEvent.click(trigger, { detail: 1 });

    // Enter / Space fire a click with no pointer detail.
    fireEvent.click(trigger, { detail: 0 });
    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('walks a menu with the arrow keys, Home and End, skipping disabled actions', () => {
    const select = vi.fn();
    render(
      <StatusBarProvider>
        <SlotConsumer slot={menuSlot(select)} />
        <StatusBar />
      </StatusBarProvider>
    );
    const trigger = screen.getByRole('button', { name: 'Actions' });
    fireEvent.click(trigger, { detail: 0 });
    const item = (name: string) => screen.getByRole('menuitem', { name });
    expect(item('First action')).toHaveFocus();
    const press = (key: string) =>
      fireEvent.keyDown(document.activeElement ?? document.body, { key });
    press('ArrowDown');
    expect(item('Last action')).toHaveFocus(); // "Unavailable" is disabled.
    press('ArrowDown');
    expect(item('First action')).toHaveFocus(); // Wraps.
    press('ArrowUp');
    expect(item('Last action')).toHaveFocus();
    press('Home');
    expect(item('First action')).toHaveFocus();
    press('End');
    expect(item('Last action')).toHaveFocus();

    fireEvent.click(item('Last action'));
    expect(select).toHaveBeenCalledWith('last');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('stays open under a modal opened above it: a press or Escape there is the modal’s', () => {
    renderToggle();
    fireEvent.click(screen.getByRole('button', { name: 'Options' }));
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = '<button type="button">Confirm</button>';
    document.body.append(modal);
    try {
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Confirm' }));
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.getByRole('dialog', { name: 'Options' })).toBeInTheDocument();
    } finally {
      modal.remove();
    }
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Options' })).toBeNull();
  });

  it('closes on a press whose own handler stops propagation', () => {
    render(
      <StatusBarProvider>
        <SlotConsumer slot={toggleSlot('stopped')} />
        <StatusBar />
        <button type="button" onPointerDown={(event) => event.stopPropagation()}>
          Grid header
        </button>
      </StatusBarProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Options' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Grid header' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('scrolls sideways instead of squeezing slots on top of each other', () => {
    const scss = readFileSync(resolve(__dirname, 'StatusBar.module.scss'), 'utf8');
    const block = (sel: string) => scss.match(new RegExp(`\\n${sel} \\{([^}]*)\\}`))?.[1] ?? '';
    expect(block('\\.bar')).toMatch(/overflow-x:\s*auto/);
    expect(block('\\.zone')).toMatch(/flex-shrink:\s*0/);
    expect(block('\\.zone')).not.toMatch(/min-width:\s*0/);
    expect(block('\\.label')).not.toMatch(/layout-truncate/);
    expect(block('\\.popover')).toMatch(/position:\s*fixed/);
    expect(block('\\.popover')).toMatch(/overflow-y:\s*auto/);
  });

  it('runs the latest handler of a slot re-registered with the same label', () => {
    const first = vi.fn();
    const second = vi.fn();
    const chip = (onClick: () => void): StatusBarSlot => ({
      id: 'chip',
      zone: 'left',
      item: { type: 'chip', label: 'Retry', onClick },
    });
    let registerSlot: (slot: StatusBarSlot) => void = () => {};
    const Pusher: FC = () => {
      const { register } = useStatusBar();
      registerSlot = register;
      return null;
    };
    render(
      <StatusBarProvider>
        <Pusher />
        <StatusBar />
      </StatusBarProvider>
    );
    act(() => registerSlot(chip(first)));
    act(() => registerSlot(chip(second)));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it('auto-dismisses an alert slot after its timeout', async () => {
    vi.useFakeTimers();
    try {
      const Pusher: FC = () => {
        const { register } = useStatusBar();
        useEffect(() => {
          register({
            id: 'alert-1',
            zone: 'center',
            item: { type: 'alert', label: 'Saved', timeoutMs: 1000 },
          });
        }, [register]);
        return null;
      };

      render(
        <StatusBarProvider>
          <Pusher />
          <StatusBar />
        </StatusBarProvider>
      );

      expect(screen.getByText('Saved')).toBeInTheDocument();
      // Advancing the fake timer inside act fires the auto-dismiss timeout,
      // which unregisters the slot and re-renders the bar synchronously.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.queryByText('Saved')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Timers must be real for the non-alert tests above.
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.useRealTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setZoom(1);
  vi.useRealTimers();
});
