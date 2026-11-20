/**
 * Per-thread chat text size — the default, the stored value (the reload
 * path), the fallback for an invalid stored value, isolation between
 * threads, live updates, and the --chat-text-base override it produces.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setThreadTextSize, threadTextSizeStyle, useThreadTextSize } from './threadTextSize';

const THREAD_A = 'thread-1111111111111-aaaaaaaaa';
const THREAD_B = 'thread-2222222222222-bbbbbbbbb';
const THREAD_C = 'thread-3333333333333-ccccccccc';
// Never set through setThreadTextSize, so they always read from storage.
const STORED_THREAD = 'thread-4444444444444-ddddddddd';
const INVALID_THREAD = 'thread-5555555555555-eeeeeeeee';

const keyFor = (threadId: string) => `snaglet.dashboard.chat.textSize.${threadId}`;

afterEach(() => {
  for (const id of [THREAD_A, THREAD_B, THREAD_C]) setThreadTextSize(id, 'small');
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('useThreadTextSize', () => {
  it('defaults to Small, which keeps the token default (no override)', () => {
    const { result } = renderHook(() => useThreadTextSize(THREAD_A));
    expect(result.current).toBe('small');
    expect(threadTextSizeStyle(result.current)).toBeUndefined();
  });

  // A thread nobody has set this session reads straight from localStorage,
  // exactly as every thread does after a reload.
  it('reads the stored size for a thread (the reload path)', () => {
    window.localStorage.setItem(keyFor(STORED_THREAD), 'large');
    const { result } = renderHook(() => useThreadTextSize(STORED_THREAD));
    expect(result.current).toBe('large');
    expect(threadTextSizeStyle(result.current)).toEqual({ '--chat-text-base': '17px' });
  });

  it('falls back to Small for an invalid stored value', () => {
    window.localStorage.setItem(keyFor(INVALID_THREAD), 'huge');
    const { result } = renderHook(() => useThreadTextSize(INVALID_THREAD));
    expect(result.current).toBe('small');
  });

  it('keeps each thread to its own size', () => {
    const a = renderHook(() => useThreadTextSize(THREAD_A));
    const b = renderHook(() => useThreadTextSize(THREAD_B));

    act(() => setThreadTextSize(THREAD_A, 'xlarge'));

    expect(a.result.current).toBe('xlarge');
    expect(b.result.current).toBe('small');
    expect(window.localStorage.getItem(keyFor(THREAD_A))).toBe('xlarge');
    expect(window.localStorage.getItem(keyFor(THREAD_B))).toBeNull();
  });

  it('applies live, and going back to Small removes the stored key', () => {
    const { result } = renderHook(() => useThreadTextSize(THREAD_A));

    act(() => setThreadTextSize(THREAD_A, 'medium'));
    expect(result.current).toBe('medium');
    expect(window.localStorage.getItem(keyFor(THREAD_A))).toBe('medium');

    act(() => setThreadTextSize(THREAD_A, 'small'));
    expect(result.current).toBe('small');
    expect(window.localStorage.getItem(keyFor(THREAD_A))).toBeNull();
  });

  it('still applies when localStorage refuses the write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useThreadTextSize(THREAD_C));
    act(() => setThreadTextSize(THREAD_C, 'large'));
    expect(result.current).toBe('large');
  });

  it('follows a thread id change', () => {
    act(() => setThreadTextSize(THREAD_B, 'large'));
    const { result, rerender } = renderHook(({ id }) => useThreadTextSize(id), {
      initialProps: { id: THREAD_A },
    });
    expect(result.current).toBe('small');
    rerender({ id: THREAD_B });
    expect(result.current).toBe('large');
  });
});

describe('threadTextSizeStyle', () => {
  it('sets --chat-text-base to 15.5, 17 and 19px for Medium, Large and Extra large', () => {
    expect(threadTextSizeStyle('medium')).toEqual({ '--chat-text-base': '15.5px' });
    expect(threadTextSizeStyle('large')).toEqual({ '--chat-text-base': '17px' });
    expect(threadTextSizeStyle('xlarge')).toEqual({ '--chat-text-base': '19px' });
  });

  it('Small is the token default, 14px (keep threadTextSize.ts in step with _tokens.scss)', () => {
    const tokens = readFileSync(
      resolve(process.cwd(), '../../packages/ui/styles/_tokens.scss'),
      'utf8'
    );
    expect(tokens).toMatch(/^\s*--chat-text-base:\s*14px;/m);
  });
});
