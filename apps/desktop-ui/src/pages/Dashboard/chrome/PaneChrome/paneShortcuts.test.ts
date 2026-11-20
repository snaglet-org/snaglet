import { afterEach, describe, expect, it, vi } from 'vitest';
import { matchPaneShortcut, paneShortcutFor, paneShortcutHint } from './paneShortcuts';

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
}

afterEach(() => vi.restoreAllMocks());

describe('matchPaneShortcut', () => {
  it.each([
    [{ key: '[', metaKey: true }, 'back'],
    [{ key: '[', ctrlKey: true }, 'back'],
    [{ key: ']', metaKey: true }, 'forward'],
    [{ key: 'y', metaKey: true }, 'history'],
    [{ key: 'Y', ctrlKey: true }, 'history'],
    [{ key: 'H', metaKey: true, shiftKey: true }, 'home'],
    [{ key: 'h', metaKey: true, shiftKey: true }, 'home'],
    [{ key: 'ArrowUp', metaKey: true }, 'up'],
    [{ key: 'ArrowLeft', metaKey: true, altKey: true }, 'focusLeft'],
    [{ key: 'ArrowRight', metaKey: true, altKey: true }, 'focusRight'],
    [{ key: 'ArrowUp', metaKey: true, altKey: true }, 'focusUp'],
    [{ key: 'ArrowDown', ctrlKey: true, altKey: true }, 'focusDown'],
    [{ key: 'Tab', ctrlKey: true }, 'focusNext'],
    [{ key: 'Tab', ctrlKey: true, shiftKey: true }, 'focusPrevious'],
  ] as const)('maps %o to %s', (init, expected) => {
    expect(matchPaneShortcut(key(init))).toBe(expected);
  });

  it.each([
    { key: '[' },
    { key: '[', metaKey: true, altKey: true },
    { key: '[', metaKey: true, shiftKey: true },
    { key: 'h', metaKey: true },
    { key: 'y', metaKey: true, shiftKey: true },
    { key: 'ArrowUp', metaKey: true, shiftKey: true },
    { key: 'ArrowDown', metaKey: true },
    { key: 'ArrowLeft', altKey: true },
    { key: 'ArrowLeft', metaKey: true, altKey: true, shiftKey: true },
    { key: 'Tab', metaKey: true },
    { key: 'Tab', ctrlKey: true, altKey: true },
    { key: 'Tab' },
  ])('ignores %o', (init) => {
    expect(matchPaneShortcut(key(init))).toBeNull();
  });

  it('ignores keys pressed while an input method is composing', () => {
    expect(matchPaneShortcut(key({ key: '[', metaKey: true, isComposing: true }))).toBeNull();
  });
});

describe('paneShortcutFor', () => {
  function pressOn(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
    const event = key(init);
    if (!target.isConnected) document.body.appendChild(target);
    Object.defineProperty(event, 'target', { value: target });
    return event;
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps ⌘Y, ⌘⇧H and ⌘↑ out of text fields, where they redo or move the caret', () => {
    const field = document.createElement('textarea');
    expect(paneShortcutFor(pressOn(field, { key: 'y', metaKey: true }))).toBeNull();
    expect(paneShortcutFor(pressOn(field, { key: 'H', metaKey: true, shiftKey: true }))).toBeNull();
    expect(paneShortcutFor(pressOn(field, { key: 'ArrowUp', metaKey: true }))).toBeNull();
  });

  it('lets back, forward and pane moves through while typing', () => {
    const field = document.createElement('input');
    expect(paneShortcutFor(pressOn(field, { key: '[', metaKey: true }))).toBe('back');
    expect(paneShortcutFor(pressOn(field, { key: 'ArrowLeft', metaKey: true, altKey: true }))).toBe(
      'focusLeft'
    );
    expect(paneShortcutFor(pressOn(field, { key: 'Tab', ctrlKey: true }))).toBe('focusNext');
  });

  it('treats any element inside a rich editor as typing', () => {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const line = document.createElement('p');
    editor.appendChild(line);
    document.body.appendChild(editor);
    expect(paneShortcutFor(pressOn(line, { key: 'y', metaKey: true }))).toBeNull();
  });

  it('leaves a key another control already handled', () => {
    const event = pressOn(document.createElement('div'), { key: '[', metaKey: true });
    event.preventDefault();
    expect(paneShortcutFor(event)).toBeNull();
  });
});

describe('paneShortcutHint', () => {
  it('labels the shortcuts with Mac symbols on macOS', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    expect(paneShortcutHint('back')).toBe('⌘[');
    expect(paneShortcutHint('history')).toBe('⌘Y');
    expect(paneShortcutHint('home')).toBe('⌘⇧H');
    expect(paneShortcutHint('focusLeft')).toBe('⌘⌥←');
    expect(paneShortcutHint('focusNext')).toBe('⌃Tab');
  });

  it('labels the shortcuts with key names elsewhere', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0)');
    expect(paneShortcutHint('forward')).toBe('Ctrl+]');
    expect(paneShortcutHint('up')).toBe('Ctrl+↑');
  });
});
