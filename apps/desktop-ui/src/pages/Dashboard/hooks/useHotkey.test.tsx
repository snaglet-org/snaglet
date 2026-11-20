import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useHotkey, type HotkeyMatcher } from './useHotkey';

function Harness({ matcher, onKey }: { matcher: HotkeyMatcher; onKey: () => void }) {
  useHotkey(matcher, onKey);
  return null;
}

describe('useHotkey auto-repeat', () => {
  it('fires once for a held key: OS auto-repeat keydowns (event.repeat) are ignored by default', () => {
    const onKey = vi.fn();
    render(<Harness matcher={{ key: 'k', meta: true }} onKey={onKey} />);
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true, repeat: true });
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true, repeat: true });
    expect(onKey).toHaveBeenCalledTimes(1);
  });

  it('still swallows (preventDefault) a repeat so the browser binding does not fire', () => {
    render(<Harness matcher={{ key: 'k', meta: true }} onKey={vi.fn()} />);
    expect(fireEvent.keyDown(document.body, { key: 'k', metaKey: true, repeat: true })).toBe(false);
  });

  it('fires on every repeat when the matcher opts in with allowRepeat', () => {
    const onKey = vi.fn();
    render(<Harness matcher={{ key: '=', meta: true, allowRepeat: true }} onKey={onKey} />);
    fireEvent.keyDown(document.body, { key: '=', metaKey: true });
    fireEvent.keyDown(document.body, { key: '=', metaKey: true, repeat: true });
    fireEvent.keyDown(document.body, { key: '=', metaKey: true, repeat: true });
    expect(onKey).toHaveBeenCalledTimes(3);
  });
});
