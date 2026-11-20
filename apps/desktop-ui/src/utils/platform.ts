/**
 * True on macOS-family platforms, where shortcuts use ⌘ rather than Ctrl.
 * `navigator.platform` is deprecated but still the most reliable synchronous
 * signal in the Tauri/WebKit shell; the user agent is the fallback.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = navigator.platform || '';
  const userAgent = navigator.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(platform) || /mac os x/i.test(userAgent);
}

/** The hint for a modifier shortcut on `key`: "⌘K" on macOS, "Ctrl+K" elsewhere. */
export function shortcutHint(key: string): string {
  return isMacPlatform() ? `⌘${key}` : `Ctrl+${key}`;
}

// `Mod` is ⌘ on macOS and Ctrl elsewhere; `Ctrl` is the Control key on both.
const MAC_SYMBOLS: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };
const OTHER_NAMES: Record<string, string> = {
  Mod: 'Ctrl',
  Ctrl: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Shift',
};

/** A key combination, modifiers first: "⌘⌥1" on macOS, "Ctrl+Alt+1" elsewhere. */
export function shortcutLabel(keys: string[]): string {
  return isMacPlatform()
    ? keys.map((key) => MAC_SYMBOLS[key] ?? key).join('')
    : keys.map((key) => OTHER_NAMES[key] ?? key).join('+');
}
