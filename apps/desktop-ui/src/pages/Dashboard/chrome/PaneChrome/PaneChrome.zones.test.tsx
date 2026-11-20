import { act, render, screen, waitFor } from '@testing-library/react';
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutLeaf } from '../../layout/paneTree';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const renderDetail = vi.hoisted(() => vi.fn());
vi.mock('../../views/DetailRouter.js', () => ({ DetailRouter: () => renderDetail() }));
vi.mock('../PaneHistoryNav/PaneHistoryNav.js', () => ({
  PaneHistoryNav: () => <button type="button">History controls</button>,
}));
vi.mock('../PathHeader/PathHeader.js', () => ({
  PathHeader: () => <button type="button">Context path</button>,
}));
vi.mock('../PathHeader/useNodeAncestors.js', () => ({ useNodeAncestors: () => [] }));

import {
  PaneChrome,
  PaneChromeBoundary,
  useHasPaneChrome,
  usePaneChromeActions,
  type PaneChromeActionZone,
} from './PaneChrome';

// A real selection: an empty pane has no sidebar home, so it has no
// "Open in sidebar" button.
function makeLeaf(): LayoutLeaf {
  const selection = { kind: 'theme' } as const;
  return { kind: 'leaf', id: 'leaf-1', selection, history: { entries: [selection], index: 0 } };
}

function renderPane() {
  return render(
    <PaneChrome
      leaf={makeLeaf()}
      isActive
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onDropSelection={vi.fn()}
      onReplaceSelection={vi.fn()}
      onGoBack={vi.fn()}
      onGoForward={vi.fn()}
      onJumpToHistoryEntry={vi.fn()}
      onOpenInSidebar={vi.fn()}
    />
  );
}

const RegisteredZones = () => {
  const centerAction = useMemo(() => <button type="button">Center action</button>, []);
  const rightAction = useMemo(() => <button type="button">Right action</button>, []);
  usePaneChromeActions(centerAction);
  usePaneChromeActions(rightAction, { zone: 'right' });
  return <div>surface</div>;
};

const RegisteredAction = ({ label, zone }: { label: string; zone: PaneChromeActionZone }) => {
  const action = useMemo(() => <button type="button">{label}</button>, [label]);
  usePaneChromeActions(action, { zone });
  return null;
};

describe('PaneChrome structural zones and registration', () => {
  beforeEach(() => renderDetail.mockReset());

  it('owns history on the left, context in the center, and ordered fixed actions on the right', async () => {
    renderDetail.mockImplementation(() => <RegisteredZones />);
    renderPane();

    const left = document.querySelector('[data-pane-chrome-zone="left"]');
    const center = document.querySelector('[data-pane-chrome-zone="center"]');
    const right = document.querySelector('[data-pane-chrome-zone="right"]');
    expect(left).toContainElement(screen.getByRole('button', { name: 'History controls' }));
    expect(center).toContainElement(screen.getByRole('button', { name: 'Context path' }));
    await waitFor(() =>
      expect(center).toContainElement(screen.getByRole('button', { name: 'Center action' }))
    );
    expect(center).toContainElement(screen.getByRole('button', { name: 'Open in sidebar' }));
    expect(right).toContainElement(screen.getByRole('button', { name: 'Right action' }));
    expect(center).not.toContainElement(screen.getByRole('button', { name: 'Right action' }));
    expect(right).not.toContainElement(screen.getByRole('button', { name: 'Open in sidebar' }));

    expect(
      Array.from(right?.querySelectorAll('button') ?? []).map(
        (button) => button.getAttribute('aria-label') ?? button.textContent?.trim()
      )
    ).toEqual(['Right action', 'New tab', 'Close pane']);
  });

  it.each(['center', 'right'] satisfies PaneChromeActionZone[])(
    'does not let stale-view cleanup clear a newer %s registration',
    async (zone) => {
      let showOld = true;
      renderDetail.mockImplementation(() => (
        <>
          {showOld && <RegisteredAction label="Old action" zone={zone} />}
          <RegisteredAction label="New action" zone={zone} />
        </>
      ));
      const view = renderPane();
      await screen.findByRole('button', { name: 'New action' });

      showOld = false;
      view.rerender(
        <PaneChrome
          leaf={makeLeaf()}
          isActive
          onActivate={vi.fn()}
          onClose={vi.fn()}
          onDropSelection={vi.fn()}
          onReplaceSelection={vi.fn()}
          onGoBack={vi.fn()}
          onGoForward={vi.fn()}
          onJumpToHistoryEntry={vi.fn()}
          onOpenInSidebar={vi.fn()}
        />
      );

      await waitFor(() => expect(screen.getByRole('button', { name: 'New action' })).toBeVisible());
    }
  );
});

interface ScrollFixtureOptions {
  max: number;
  initial?: number;
  rtl?: boolean;
}

function configureRail(rail: HTMLElement, { max, initial = 0, rtl = false }: ScrollFixtureOptions) {
  let position = initial;
  Object.defineProperties(rail, {
    clientWidth: { configurable: true, value: 100 },
    scrollWidth: { configurable: true, value: 100 + max },
    scrollLeft: {
      configurable: true,
      get: () => position,
      set: (next: number) => {
        position = rtl ? Math.max(-max, Math.min(0, next)) : Math.max(0, Math.min(max, next));
      },
    },
  });
  rail.style.direction = rtl ? 'rtl' : 'ltr';
  return () => position;
}

function dispatchWheel(rail: HTMLElement, init: WheelEventInit): WheelEvent {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  rail.dispatchEvent(event);
  return event;
}

describe('PaneChrome center wheel translation', () => {
  beforeEach(() => {
    renderDetail.mockReset();
    renderDetail.mockImplementation(() => <div>surface</div>);
  });

  it('consumes vertical pixel, line, and page deltas only when the rail advances', () => {
    renderPane();
    const rail = document.querySelector<HTMLElement>('[data-pane-chrome-zone="center"]')!;
    const position = configureRail(rail, { max: 400 });

    expect(dispatchWheel(rail, { deltaY: 12 }).defaultPrevented).toBe(true);
    expect(position()).toBe(12);
    expect(dispatchWheel(rail, { deltaY: 2, deltaMode: 1 }).defaultPrevented).toBe(true);
    expect(position()).toBe(44);
    expect(dispatchWheel(rail, { deltaY: 1, deltaMode: 2 }).defaultPrevented).toBe(true);
    expect(position()).toBe(144);
  });

  it('allows vertical scrolling when there is no overflow or the requested boundary is reached', () => {
    renderPane();
    const rail = document.querySelector<HTMLElement>('[data-pane-chrome-zone="center"]')!;
    const noOverflow = configureRail(rail, { max: 0 });
    expect(dispatchWheel(rail, { deltaY: 30 }).defaultPrevented).toBe(false);
    expect(noOverflow()).toBe(0);

    const atEnd = configureRail(rail, { max: 100, initial: 100 });
    expect(dispatchWheel(rail, { deltaY: 30 }).defaultPrevented).toBe(false);
    expect(atEnd()).toBe(100);
    expect(dispatchWheel(rail, { deltaY: -30 }).defaultPrevented).toBe(true);
    expect(atEnd()).toBe(70);
  });

  it('leaves native horizontal, Shift+wheel, and zoom gestures untouched', () => {
    renderPane();
    const rail = document.querySelector<HTMLElement>('[data-pane-chrome-zone="center"]')!;
    const position = configureRail(rail, { max: 200 });

    expect(dispatchWheel(rail, { deltaX: 4, deltaY: 30 }).defaultPrevented).toBe(false);
    expect(dispatchWheel(rail, { deltaY: 30, shiftKey: true }).defaultPrevented).toBe(false);
    expect(dispatchWheel(rail, { deltaY: 30, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(dispatchWheel(rail, { deltaY: 30, metaKey: true }).defaultPrevented).toBe(false);
    expect(position()).toBe(0);
  });

  it('normalizes RTL movement and releases vertical scroll at both logical boundaries', () => {
    renderPane();
    const rail = document.querySelector<HTMLElement>('[data-pane-chrome-zone="center"]')!;
    const position = configureRail(rail, { max: 100, rtl: true });

    expect(dispatchWheel(rail, { deltaY: 20 }).defaultPrevented).toBe(true);
    expect(position()).toBe(-20);
    configureRail(rail, { max: 100, initial: -100, rtl: true });
    expect(dispatchWheel(rail, { deltaY: 20 }).defaultPrevented).toBe(false);
    expect(dispatchWheel(rail, { deltaY: -20 }).defaultPrevented).toBe(true);
  });
});

// A view inside a modal opened from the pane (the link preview hosts a full
// DocView). Context flows through the portal, so without a boundary its
// controls replaced the pane's own while open and cleared them on close.
let openPreview: (open: boolean) => void = () => {};
const PreviewHost = ({ bounded }: { bounded: boolean }) => {
  const [open, setOpen] = useState(false);
  openPreview = setOpen;
  const own = useMemo(() => <button type="button">Pane control</button>, []);
  usePaneChromeActions(own);
  const inner = <RegisteredAction label="Preview control" zone="center" />;
  return open
    ? createPortal(
        bounded ? <PaneChromeBoundary>{inner}</PaneChromeBoundary> : inner,
        document.body
      )
    : null;
};

describe('PaneChromeBoundary', () => {
  beforeEach(() => renderDetail.mockReset());

  it('keeps a modal-hosted view from taking over, then erasing, the pane topbar', async () => {
    renderDetail.mockImplementation(() => <PreviewHost bounded />);
    renderPane();
    await screen.findByRole('button', { name: 'Pane control' });

    act(() => openPreview(true));
    expect(screen.queryByRole('button', { name: 'Preview control' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Pane control' })).toBeInTheDocument();

    act(() => openPreview(false));
    expect(screen.getByRole('button', { name: 'Pane control' })).toBeInTheDocument();
  });

  it('without it the leak is real (guards the test itself)', async () => {
    renderDetail.mockImplementation(() => <PreviewHost bounded={false} />);
    renderPane();
    await screen.findByRole('button', { name: 'Pane control' });
    act(() => openPreview(true));
    act(() => openPreview(false));
    expect(screen.queryByRole('button', { name: 'Pane control' })).toBeNull();
  });

  it('reads as "no pane" inside', () => {
    let inside: boolean | null = null;
    const Probe = () => {
      inside = useHasPaneChrome();
      return null;
    };
    renderDetail.mockImplementation(() => (
      <PaneChromeBoundary>
        <Probe />
      </PaneChromeBoundary>
    ));
    renderPane();
    expect(inside).toBe(false);
  });
});
