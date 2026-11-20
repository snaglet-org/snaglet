import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { draftStorageKey, readStoredDraft, usePersistentDraft } from './usePersistentDraft';

const KEY_A = draftStorageKey('test:a');
const KEY_B = draftStorageKey('test:b');

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('usePersistentDraft', () => {
  it('hydrates from storage and falls back to the initial text', () => {
    localStorage.setItem(KEY_A, JSON.stringify({ text: 'stored' }));
    expect(renderHook(() => usePersistentDraft(KEY_A)).result.current.draftText).toBe('stored');
    expect(renderHook(() => usePersistentDraft(KEY_B, 'initial')).result.current.draftText).toBe(
      'initial'
    );
  });

  it('writes user edits after the debounce and flushes the last one on unmount', () => {
    const { result, unmount } = renderHook(() => usePersistentDraft(KEY_A));
    act(() => result.current.setDraftText('typed'));
    expect(readStoredDraft(KEY_A)).toBeNull();
    act(() => vi.advanceTimersByTime(300));
    expect(readStoredDraft(KEY_A)).toBe('typed');

    act(() => result.current.setDraftText('typed more'));
    unmount();
    expect(readStoredDraft(KEY_A)).toBe('typed more');
  });

  it('never stores text equal to the initial text', () => {
    const { result, unmount } = renderHook(() => usePersistentDraft(KEY_A, 'entry body'));
    act(() => result.current.setDraftText('entry body'));
    unmount();
    expect(localStorage.getItem(KEY_A)).toBeNull();
  });

  it('does not rewrite a draft it only hydrated', () => {
    localStorage.setItem(KEY_A, JSON.stringify({ text: 'stored' }));
    const { unmount } = renderHook(() => usePersistentDraft(KEY_A));
    localStorage.setItem(KEY_A, JSON.stringify({ text: 'seeded elsewhere' }));
    unmount();
    expect(readStoredDraft(KEY_A)).toBe('seeded elsewhere');
  });

  it('flushes the old key and loads the new one when the key changes', () => {
    localStorage.setItem(KEY_B, JSON.stringify({ text: 'draft b' }));
    const { result, rerender } = renderHook(({ k }) => usePersistentDraft(k), {
      initialProps: { k: KEY_A },
    });
    act(() => result.current.setDraftText('draft a'));
    rerender({ k: KEY_B });
    expect(readStoredDraft(KEY_A)).toBe('draft a');
    expect(result.current.draftText).toBe('draft b');
  });

  it('clearDraft empties the field; discardDraft keeps it; neither re-stores on unmount', () => {
    const cleared = renderHook(() => usePersistentDraft(KEY_A));
    act(() => cleared.result.current.setDraftText('sent'));
    act(() => cleared.result.current.clearDraft());
    expect(cleared.result.current.draftText).toBe('');
    cleared.unmount();
    expect(localStorage.getItem(KEY_A)).toBeNull();

    const discarded = renderHook(() => usePersistentDraft(KEY_B));
    act(() => discarded.result.current.setDraftText('closing'));
    act(() => discarded.result.current.discardDraft());
    expect(discarded.result.current.draftText).toBe('closing');
    discarded.unmount();
    expect(localStorage.getItem(KEY_B)).toBeNull();
  });

  it('keeps the draft in memory only without a key', () => {
    const { result, unmount } = renderHook(() => usePersistentDraft(undefined));
    act(() => result.current.setDraftText('ephemeral'));
    act(() => vi.advanceTimersByTime(300));
    unmount();
    expect(localStorage.length).toBe(0);
  });
});
