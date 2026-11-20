import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZOOM_CHANGED_EVENT } from '@desktop/components/StatusBar/consumers/zoomWindow';
import { CellPickerPopover } from './CellPickerPopover';

const anchors: HTMLElement[] = [];
function anchorAt(rect: DOMRect) {
  const anchor = document.createElement('div');
  document.body.append(anchor);
  anchors.push(anchor);
  const geometry = vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect);
  return { anchor, geometry };
}

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

function placed(popup: HTMLElement | null) {
  const style = popup?.style;
  return {
    left: Number.parseFloat(style?.left ?? ''),
    top: Number.parseFloat(style?.top ?? ''),
    width: Number.parseFloat(style?.width ?? ''),
  };
}

afterEach(() => {
  for (const anchor of anchors.splice(0)) anchor.remove();
  vi.restoreAllMocks();
  window.dispatchEvent(new CustomEvent(ZOOM_CHANGED_EVENT));
});

describe('CellPickerPopover', () => {
  it('portals beneath the cell without row-flow changes and permits native autofocus', () => {
    const { anchor } = anchorAt(new DOMRect(100, 200, 180, 36));
    const view = render(
      <CellPickerPopover anchor={anchor}>
        <input aria-label="Filter options" autoFocus />
      </CellPickerPopover>
    );
    const input = screen.getByRole('textbox', { name: 'Filter options' });
    const popup = input.parentElement;
    expect(view.container.contains(input)).toBe(false);
    expect(popup?.parentElement).toBe(document.body);
    expect(popup).toHaveAttribute('data-keeps-cell', '');
    expect(popup).toHaveAttribute('data-pane-drop-target', 'node-chip');
    expect(popup).toHaveStyle({ left: '100px', top: '240px', width: '240px' });
    expect(input).toHaveFocus();
  });

  it('tracks scroll geometry and flips above the cell when room below runs out', () => {
    const { anchor, geometry } = anchorAt(new DOMRect(100, 200, 180, 36));
    render(
      <CellPickerPopover anchor={anchor}>
        <span>Choices</span>
      </CellPickerPopover>
    );
    const popup = screen.getByText('Choices').parentElement;
    geometry.mockReturnValue(new DOMRect(80, 680, 180, 36));
    fireEvent.scroll(window);
    expect(popup).toHaveStyle({ left: '80px', top: '436px' });
    geometry.mockReturnValue(new DOMRect(60, 140, 180, 36));
    fireEvent.resize(window);
    expect(popup).toHaveStyle({ left: '60px', top: '180px' });
  });

  it('stays within narrow pane edges instead of the browser-wide viewport', () => {
    const pane = document.createElement('div');
    pane.className = 'pane-body';
    document.body.append(pane);
    anchors.push(pane);
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(new DOMRect(300, 100, 200, 450));
    const { anchor } = anchorAt(new DOMRect(460, 180, 100, 36));
    pane.append(anchor);
    render(
      <CellPickerPopover anchor={anchor}>
        <span>Choices</span>
      </CellPickerPopover>
    );
    expect(screen.getByText('Choices').parentElement).toHaveStyle({
      left: '308px',
      top: '220px',
      width: '184px',
    });
  });

  it('renders nothing until a live anchor is supplied and removes the portal on unmount', () => {
    const { anchor } = anchorAt(new DOMRect(100, 200, 180, 36));
    const view = render(
      <CellPickerPopover anchor={null}>
        <span>Choices</span>
      </CellPickerPopover>
    );
    expect(screen.queryByText('Choices')).not.toBeInTheDocument();
    view.rerender(
      <CellPickerPopover anchor={anchor}>
        <span>Choices</span>
      </CellPickerPopover>
    );
    expect(screen.getByText('Choices')).toBeInTheDocument();
    view.unmount();
    expect(document.querySelector('[data-cell-picker-popover]')).toBeNull();
  });

  describe('under the root zoom (portaled to <body>)', () => {
    it('lands on the cell at 1.25: CSS left is rect.left / 1.25', () => {
      stubRootZoom(1.25);
      const { anchor } = anchorAt(new DOMRect(100, 200, 180, 36));
      render(
        <CellPickerPopover anchor={anchor}>
          <span>Choices</span>
        </CellPickerPopover>
      );
      const at = placed(screen.getByText('Choices').parentElement);
      expect(at.left).toBeCloseTo(100 / 1.25, 6);
      // Below the cell by the 4px gap, which scales with the zoom like the card.
      expect(at.top).toBeCloseTo((236 + 4 * 1.25) / 1.25, 6);
      expect(at.width).toBe(240);
    });

    it('clamps to the right edge with the card at its on-screen width', () => {
      stubRootZoom(1.25);
      const { anchor } = anchorAt(new DOMRect(950, 200, 60, 36));
      render(
        <CellPickerPopover anchor={anchor}>
          <span>Choices</span>
        </CellPickerPopover>
      );
      const at = placed(screen.getByText('Choices').parentElement);
      expect((at.left + at.width) * 1.25).toBeCloseTo(1024 - 8 * 1.25, 6);
    });

    it("matches a wide cell's on-screen width", () => {
      stubRootZoom(1.25);
      const { anchor } = anchorAt(new DOMRect(100, 200, 400, 36));
      render(
        <CellPickerPopover anchor={anchor}>
          <span>Choices</span>
        </CellPickerPopover>
      );
      expect(placed(screen.getByText('Choices').parentElement).width).toBeCloseTo(400 / 1.25, 6);
    });

    it('changes nothing at 1', () => {
      stubRootZoom(1);
      const { anchor } = anchorAt(new DOMRect(950, 200, 60, 36));
      render(
        <CellPickerPopover anchor={anchor}>
          <span>Choices</span>
        </CellPickerPopover>
      );
      expect(screen.getByText('Choices').parentElement).toHaveStyle({
        left: `${1024 - 8 - 240}px`,
        top: '240px',
        width: '240px',
      });
    });
  });
});
