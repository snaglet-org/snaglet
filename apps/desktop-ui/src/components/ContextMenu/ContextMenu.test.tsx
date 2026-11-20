import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZOOM_CHANGED_EVENT } from '@desktop/components/StatusBar/consumers/zoomWindow';
import { ContextMenu } from './ContextMenu';

/** Answer utils/cssZoom's fixed-layer probes as an engine would at `scale`. */
function stubRootZoom(scale: number) {
  const original = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const probe = this.getAttribute('data-fixed-layer-probe');
    if (probe === 'unit') return new DOMRect(100 * scale, 100 * scale, 100 * scale, 100 * scale);
    if (probe === 'viewport') return new DOMRect(0, 0, innerWidth, innerHeight);
    return original.call(this);
  });
  window.dispatchEvent(new CustomEvent(ZOOM_CHANGED_EVENT));
}

function openAt(x: number, y: number) {
  render(
    <ContextMenu
      ariaLabel="Row actions"
      x={x}
      y={y}
      items={[{ label: 'Rename', onSelect: () => {} }]}
      onClose={() => {}}
    />
  );
  const style = screen.getByRole('menu', { name: 'Row actions' }).style;
  return { left: Number.parseFloat(style.left), top: Number.parseFloat(style.top) };
}

afterEach(() => {
  vi.restoreAllMocks();
  window.dispatchEvent(new CustomEvent(ZOOM_CHANGED_EVENT));
});

describe('ContextMenu placement', () => {
  it('opens at the pointer at zoom 1', () => {
    expect(openAt(400, 135)).toEqual({ left: 400, top: 135 });
  });

  it("converts the pointer to the menu's own px under the root zoom", () => {
    stubRootZoom(1.25);
    const at = openAt(400, 135);
    expect(at.left).toBeCloseTo(400 / 1.25, 6);
    expect(at.top).toBeCloseTo(135 / 1.25, 6);
  });

  it('keeps the 220px menu on screen at its zoomed width', () => {
    stubRootZoom(1.25);
    // jsdom measures nothing, so the menu's 220px default stands in.
    const at = openAt(1000, 135);
    expect((at.left + 220) * 1.25).toBeCloseTo(1024 - 8 * 1.25, 6);
  });
});

describe('ContextMenu draggable items', () => {
  it('an item with onDragStart drags, and the menu closes when the drag ends', () => {
    const onDragStart = vi.fn();
    const onClose = vi.fn();
    render(
      <ContextMenu
        ariaLabel="Create"
        x={10}
        y={10}
        items={[
          { label: 'New thing', onSelect: () => {}, onDragStart },
          { label: 'Plain', onSelect: () => {} },
        ]}
        onClose={onClose}
      />
    );
    const item = screen.getByRole('menuitem', { name: 'New thing' });
    expect(item).toHaveAttribute('draggable', 'true');
    expect(screen.getByRole('menuitem', { name: 'Plain' })).not.toHaveAttribute('draggable');

    fireEvent.dragStart(item);
    expect(onDragStart).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.dragEnd(item);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('ContextMenu toggles and shortcuts', () => {
  it('renders a checked item as a checkbox item with its shortcut, and arrows reach it', () => {
    render(
      <ContextMenu
        ariaLabel="Format"
        x={10}
        y={10}
        items={[
          { label: 'Plain', onSelect: () => {} },
          { label: 'Bold', checked: true, shortcut: '⌘B', onSelect: () => {} },
          { label: 'Italic', checked: false, separatorBefore: true, onSelect: () => {} },
        ]}
        onClose={() => {}}
      />
    );
    const bold = screen.getByRole('menuitemcheckbox', { name: /Bold/ });
    expect(bold).toHaveAttribute('aria-checked', 'true');
    expect(bold).toHaveAttribute('aria-keyshortcuts', '⌘B');
    expect(bold).toHaveTextContent('⌘B');
    expect(screen.getByRole('menuitemcheckbox', { name: /Italic/ })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    expect(screen.getByRole('menuitem', { name: 'Plain' })).not.toHaveAttribute('aria-checked');

    const menu = screen.getByRole('menu', { name: 'Format' });
    expect(screen.getByRole('menuitem', { name: 'Plain' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(bold).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(screen.getByRole('menuitemcheckbox', { name: /Italic/ })).toHaveFocus();
  });
});
