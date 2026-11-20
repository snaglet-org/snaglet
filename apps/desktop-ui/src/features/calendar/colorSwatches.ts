/**
 * Color helpers for the calendar color popover: the live workspace-theme
 * swatches, and a small client-only "recent custom colors" store.
 *
 * They live here because the calendar popover is their only consumer.
 * The recent-colors store is module state + `useSyncExternalStore`, persisted
 * best-effort to localStorage in a versioned envelope; a malformed payload
 * degrades to an empty list.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { safeJsonParse } from '@snaglet/shared/utils';
import {
  defaultWorkspaceColors,
  workspaceColorTokens,
} from '@snaglet/shared/constants/workspaceTheme';
import { subscribeTheme } from '@desktop/utils/workspaceTheme';

const MAX_RECENT_COLORS = 8;
const RECENT_COLORS_STORAGE_KEY = 'snaglet.calendar.recentColors';
/**
 * A fallback key holding the same envelope. Read only when the current key is
 * empty; its payload is then copied to the current key and the fallback deleted.
 */
const LEGACY_RECENT_COLORS_STORAGE_KEY = 'snaglet.sketch.recentColors';
const STORAGE_VERSION = 1;

export interface WorkspaceSwatch {
  hex: string;
  /** Token labels sharing this color, e.g. "Surface, Raised". */
  label: string;
  /** Those tokens' names in palette order, e.g. ["background", "raised"]. */
  tokens: string[];
}

/** `#rgb`/`#rrggbb` → canonical lowercase `#rrggbb`, else null. */
function normalizeColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(trimmed))
    return `#${[...trimmed.slice(1)].map((c) => c + c).join('')}`.toLowerCase();
  return null;
}

function read(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function writeColors(colors: string[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(
      RECENT_COLORS_STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, colors })
    );
  } catch {
    /* best-effort */
  }
}

/**
 * The persisted payload under the current key, else the fallback key's
 * (copied to the current key and deleted, so the fallback runs once).
 */
function readStoredRecentColors(): string | null {
  const current = read(RECENT_COLORS_STORAGE_KEY);
  if (current !== null) return current;
  const legacy = read(LEGACY_RECENT_COLORS_STORAGE_KEY);
  if (legacy === null) return null;
  try {
    localStorage.setItem(RECENT_COLORS_STORAGE_KEY, legacy);
    localStorage.removeItem(LEGACY_RECENT_COLORS_STORAGE_KEY);
  } catch {
    /* best-effort */
  }
  return legacy;
}

function parseStoredRecentColors(text: string | null): string[] {
  try {
    const parsed: unknown = text ? safeJsonParse<unknown>(text, null) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const envelope = parsed as Record<string, unknown>;
    if (envelope.version !== STORAGE_VERSION || !Array.isArray(envelope.colors)) return [];
    const colors: string[] = [];
    for (const item of envelope.colors) {
      const color = normalizeColor(item);
      if (color && !colors.includes(color)) colors.push(color);
      if (colors.length >= MAX_RECENT_COLORS) break;
    }
    return colors;
  } catch {
    return [];
  }
}

let recentColors: string[] = parseStoredRecentColors(readStoredRecentColors());
const listeners = new Set<() => void>();
function notify(): void {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const getRecentColors = (): string[] => recentColors;

/** Re-read the persisted recent-colors list (test seam after mutating storage). */
export function reloadRecentColors(): void {
  recentColors = parseStoredRecentColors(readStoredRecentColors());
  notify();
}

export function useRecentColors(): string[] {
  return useSyncExternalStore(subscribe, getRecentColors, getRecentColors);
}

/** Most recent first, de-duplicated, bounded. */
export function rememberRecentColor(value: string): void {
  const color = normalizeColor(value);
  if (!color || recentColors[0] === color) return;
  recentColors = [color, ...recentColors.filter((c) => c !== color)].slice(0, MAX_RECENT_COLORS);
  writeColors(recentColors);
  notify();
}

function readWorkspaceSwatches(): WorkspaceSwatch[] {
  const root = typeof document !== 'undefined' ? document.documentElement.style : null;
  const swatches = new Map<string, Array<{ name: string; label: string }>>();
  for (const token of workspaceColorTokens) {
    const inline = root?.getPropertyValue(`--${token.name}`).trim();
    const hex = normalizeColor(inline) ?? normalizeColor(defaultWorkspaceColors[token.name]);
    if (!hex) continue;
    swatches.set(hex, [...(swatches.get(hex) ?? []), token]);
  }
  return [...swatches].map(([hex, tokens]) => ({
    hex,
    label: tokens.map((t) => t.label).join(', '),
    tokens: tokens.map((t) => t.name),
  }));
}

/** The live workspace swatches while `active`, re-read on every theme change. */
export function useWorkspaceSwatches(active: boolean): WorkspaceSwatch[] {
  const [swatches, setSwatches] = useState<WorkspaceSwatch[]>(() =>
    active ? readWorkspaceSwatches() : []
  );
  useEffect(() => {
    if (!active) return;
    setSwatches(readWorkspaceSwatches());
    return subscribeTheme(() => setSwatches(readWorkspaceSwatches()));
  }, [active]);
  return swatches;
}
