import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMacPlatform, shortcutHint, shortcutLabel } from './platform';

function stubPlatform(platform: string, userAgent = '') {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
}

afterEach(() => vi.restoreAllMocks());

describe('platform', () => {
  it('uses ⌘ on macOS-family platforms', () => {
    stubPlatform('MacIntel');
    expect(isMacPlatform()).toBe(true);
    expect(shortcutHint('K')).toBe('⌘K');
  });

  it('falls back to the user agent when the platform is blank', () => {
    stubPlatform('', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    expect(isMacPlatform()).toBe(true);
  });

  it('uses Ctrl+ elsewhere', () => {
    stubPlatform('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    expect(isMacPlatform()).toBe(false);
    expect(shortcutHint('R')).toBe('Ctrl+R');
  });

  it('labels a key combination with Mac symbols on macOS', () => {
    stubPlatform('MacIntel');
    expect(shortcutLabel(['Mod', 'Alt', '1'])).toBe('⌘⌥1');
    expect(shortcutLabel(['Mod', 'Shift', 'H'])).toBe('⌘⇧H');
    expect(shortcutLabel(['Ctrl', 'Tab'])).toBe('⌃Tab');
  });

  it('labels a key combination with names joined by plus signs elsewhere', () => {
    stubPlatform('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    expect(shortcutLabel(['Mod', 'Alt', '1'])).toBe('Ctrl+Alt+1');
    expect(shortcutLabel(['Mod', 'Shift', 'H'])).toBe('Ctrl+Shift+H');
    expect(shortcutLabel(['Ctrl', 'Tab'])).toBe('Ctrl+Tab');
  });
});
