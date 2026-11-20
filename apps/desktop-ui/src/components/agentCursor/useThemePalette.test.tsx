import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultWorkspaceColors } from '@snaglet/shared/constants/workspaceTheme';
import { THEME_CHANGED } from '@desktop/utils/workspaceTheme';
import { resolvePalette, useThemePalette } from './useThemePalette';

afterEach(() => document.documentElement.removeAttribute('style'));

describe('resolvePalette', () => {
  it('uses the reader value and trims it', () => {
    const palette = resolvePalette((name) => (name === '--agent' ? '  #123456 ' : ''));
    expect(palette.agent).toBe('#123456');
  });
  it('falls back to defaults for unset or empty values', () => {
    const palette = resolvePalette(() => '');
    expect(palette).toEqual(defaultWorkspaceColors);
    expect(resolvePalette(() => null)).toEqual(defaultWorkspaceColors);
  });
});

describe('useThemePalette', () => {
  it('re-reads on theme change and keeps identity when nothing changed', () => {
    const { result } = renderHook(() => useThemePalette());
    const first = result.current;
    expect(first.agent).toBe(defaultWorkspaceColors.agent);
    act(() => void window.dispatchEvent(new Event(THEME_CHANGED)));
    expect(result.current).toBe(first);
    document.documentElement.style.setProperty('--agent', '#010203');
    act(() => void window.dispatchEvent(new Event(THEME_CHANGED)));
    expect(result.current.agent).toBe('#010203');
  });
});
