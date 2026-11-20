import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_CHANGED_EVENT,
  ZOOM_STORAGE_KEY,
  applyPersistedZoom,
  getZoom,
  isDesktopShell,
  resetZoom,
  setZoom,
  zoomIn,
  zoomOut,
} from './zoomWindow';

// localStorage is the module's source of truth and the root style is its
// output — reset both so every test starts at the 100% default.
beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.style.removeProperty('zoom');
  document.documentElement.style.removeProperty('--snaglet-zoom');
  document.documentElement.style.removeProperty('--snaglet-viewport-zoom');
  delete (window as { __SNAGLET_DESKTOP__?: unknown }).__SNAGLET_DESKTOP__;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const rootZoom = () => document.documentElement.style.getPropertyValue('zoom');
const rootVar = (name: string) => document.documentElement.style.getPropertyValue(name);

/**
 * Stand in for an engine's layout: the `100vw` probe and the `inset: 0` probe
 * report these widths (in whatever rect units that engine uses).
 */
function layoutReports(unitsWidth: number, frameWidth: number) {
  return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const width = this.style.width === '100vw' ? unitsWidth : frameWidth;
    return { x: 0, y: 0, left: 0, top: 0, width, height: 0, right: width, bottom: 0 } as DOMRect;
  });
}

describe('zoomWindow', () => {
  it('defaults to 100% when nothing is persisted', () => {
    expect(getZoom()).toBe(1);
  });

  it('setZoom applies CSS zoom + the --snaglet-zoom level var and persists the level', () => {
    setZoom(1.25);
    expect(rootZoom()).toBe('1.25');
    // unzoomed() divides px lengths by this; every engine zooms px.
    expect(rootVar('--snaglet-zoom')).toBe('1.25');
    expect(window.localStorage.getItem(ZOOM_STORAGE_KEY)).toBe('1.25');
    expect(getZoom()).toBe(1.25);
  });

  describe('--snaglet-viewport-zoom (how much the engine zooms vw / vh)', () => {
    it('is the level on an engine that zooms viewport units (standardized zoom)', () => {
      // Chromium and current WebKit at 80%: 100vw covers 0.8 of the window.
      layoutReports(1024, 1280);
      setZoom(0.8);
      expect(rootVar('--snaglet-viewport-zoom')).toBe('0.8');
    });

    it('is 1 on an engine whose viewport units ignore the zoom (Safari 17)', () => {
      // WebKit 17 at 80%: both probes fill the 1280px window and report it
      // in the element's own px (1280 / 0.8).
      layoutReports(1600, 1600);
      setZoom(0.8);
      expect(rootVar('--snaglet-viewport-zoom')).toBe('1');
      // The level itself is unchanged: px lengths are still zoomed by it.
      expect(rootVar('--snaglet-zoom')).toBe('0.8');

      layoutReports(1024, 1024);
      setZoom(1.25);
      expect(rootVar('--snaglet-viewport-zoom')).toBe('1');
    });

    it('snaps a ratio within layout rounding or a scrollbar to the known behavior', () => {
      // 100vw includes a 15px classic scrollbar the inset: 0 frame excludes.
      layoutReports(1600, 1265);
      setZoom(1.25);
      expect(rootVar('--snaglet-viewport-zoom')).toBe('1.25');

      layoutReports(1279, 1280);
      setZoom(1.5);
      expect(rootVar('--snaglet-viewport-zoom')).toBe('1');
    });

    it('trusts the measured ratio from an engine that does neither', () => {
      layoutReports(1152, 1280);
      setZoom(0.8);
      expect(rootVar('--snaglet-viewport-zoom')).toBe('0.9');
    });

    it('falls back to the level where layout reports nothing', () => {
      // jsdom: every rect is empty.
      setZoom(1.25);
      expect(rootVar('--snaglet-viewport-zoom')).toBe('1.25');
    });

    it('measures with hidden probes it removes again', () => {
      layoutReports(1024, 1280);
      setZoom(0.8);
      expect(document.querySelectorAll('[data-viewport-zoom-probe]')).toHaveLength(0);
    });

    it('is cleared with the zoom at exactly 100%', () => {
      layoutReports(1024, 1280);
      setZoom(0.8);
      setZoom(1);
      expect(rootVar('--snaglet-viewport-zoom')).toBe('');
      expect(rootVar('--snaglet-zoom')).toBe('');
    });
  });

  it('setZoom clamps arbitrary values to the ladder ends', () => {
    setZoom(5);
    expect(getZoom()).toBe(MAX_ZOOM);
    setZoom(0.1);
    expect(getZoom()).toBe(MIN_ZOOM);
  });

  it('removes the inline zoom property at exactly 100%', () => {
    setZoom(1.25);
    setZoom(1);
    expect(rootZoom()).toBe('');
    expect(getZoom()).toBe(1);
  });

  it('zoomIn walks up the browser-like ladder and clamps at 200%', () => {
    const seen: number[] = [];
    // 1 → 1.1 → 1.25 → 1.5 → 1.75 → 2 → (clamped) 2
    for (let i = 0; i < 6; i += 1) {
      zoomIn();
      seen.push(getZoom());
    }
    expect(seen).toEqual([1.1, 1.25, 1.5, 1.75, 2, 2]);
    expect(rootZoom()).toBe('2');
  });

  it('zoomOut walks down the ladder and clamps at 80%', () => {
    const seen: number[] = [];
    // 1 → 0.9 → 0.8 → (clamped) 0.8
    for (let i = 0; i < 3; i += 1) {
      zoomOut();
      seen.push(getZoom());
    }
    expect(seen).toEqual([0.9, 0.8, 0.8]);
    expect(rootZoom()).toBe('0.8');
  });

  it('stepping from an off-ladder persisted value snaps to the adjacent step', () => {
    window.localStorage.setItem(ZOOM_STORAGE_KEY, '0.95');
    zoomIn();
    expect(getZoom()).toBe(1);
    window.localStorage.setItem(ZOOM_STORAGE_KEY, '0.95');
    zoomOut();
    expect(getZoom()).toBe(0.9);
  });

  it('resetZoom restores 100% and persists it', () => {
    setZoom(1.5);
    resetZoom();
    expect(getZoom()).toBe(1);
    expect(window.localStorage.getItem(ZOOM_STORAGE_KEY)).toBe('1');
    expect(rootZoom()).toBe('');
  });

  it('persistence round-trips: applyPersistedZoom re-applies the stored level on boot', () => {
    setZoom(1.5);
    // Simulate a reload: the inline style is gone, storage remains.
    document.documentElement.style.removeProperty('zoom');
    applyPersistedZoom();
    expect(rootZoom()).toBe('1.5');
    expect(getZoom()).toBe(1.5);
  });

  it('falls back to 100% on unreadable or nonsense persisted values', () => {
    window.localStorage.setItem(ZOOM_STORAGE_KEY, 'garbage');
    expect(getZoom()).toBe(1);
    window.localStorage.setItem(ZOOM_STORAGE_KEY, '-2');
    expect(getZoom()).toBe(1);
    window.localStorage.setItem(ZOOM_STORAGE_KEY, '9');
    expect(getZoom()).toBe(MAX_ZOOM); // out of range but numeric → clamped
  });

  it('announces every change via the zoom-changed window event', () => {
    const onChange = vi.fn();
    window.addEventListener(ZOOM_CHANGED_EVENT, onChange);
    try {
      zoomIn();
      resetZoom();
      expect(onChange).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener(ZOOM_CHANGED_EVENT, onChange);
    }
  });

  it('isDesktopShell reflects the injected __SNAGLET_DESKTOP__ marker', () => {
    expect(isDesktopShell()).toBe(false);
    (window as { __SNAGLET_DESKTOP__?: unknown }).__SNAGLET_DESKTOP__ = { apiBaseUrl: 'http://x' };
    expect(isDesktopShell()).toBe(true);
  });
});
