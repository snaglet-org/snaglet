/**
 * resolveDroppedFilePath — the Tauri-invoke wrapper around Spotlight
 * path-recovery (`resolve_dropped_file_path` in
 * apps/desktop/src-tauri/src/drop_path_recovery.rs`).
 *
 * Covers the three outcomes the Rust side can return, plus the two
 * environments where we must degrade gracefully instead of throwing:
 * a plain browser (no `__TAURI__`/`__TAURI_INTERNALS__`) and a Tauri
 * webview where the invoke itself fails for any reason.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { resolveDroppedFilePath } from './resolveDroppedFilePath';

function markTauri() {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
}

afterEach(() => {
  invokeMock.mockReset();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

describe('resolveDroppedFilePath — web-only build (no Tauri)', () => {
  it('resolves to not_found without hashing or invoking anything', async () => {
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    const result = await resolveDroppedFilePath(file);
    expect(result).toEqual({ status: 'not_found' });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe('resolveDroppedFilePath — inside Tauri', () => {
  it('hashes the file and invokes resolve_dropped_file_path with name/size/contentHash', async () => {
    markTauri();
    invokeMock.mockResolvedValue({ status: 'unique', path: '/Users/user/hello.txt' });

    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    const result = await resolveDroppedFilePath(file);

    expect(invokeMock).toHaveBeenCalledWith('resolve_dropped_file_path', {
      name: 'hello.txt',
      size: file.size,
      // sha256("hello") — pinned so this test also guards the hex encoding,
      // not just that *some* string was passed.
      contentHash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      isDirectory: false,
    });
    expect(result).toEqual({ status: 'unique', path: '/Users/user/hello.txt' });
  });

  it('a directory skips hashing and invokes with isDirectory and an empty hash', async () => {
    markTauri();
    invokeMock.mockResolvedValue({ status: 'unique', path: '/Users/user/overlay-lab' });

    const dir = new File([], 'overlay-lab');
    const arrayBuffer = vi.spyOn(dir, 'arrayBuffer');
    const result = await resolveDroppedFilePath(dir, { isDirectory: true });

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith('resolve_dropped_file_path', {
      name: 'overlay-lab',
      size: 0,
      contentHash: '',
      isDirectory: true,
    });
    expect(result).toEqual({ status: 'unique', path: '/Users/user/overlay-lab' });
  });

  it('an unreadable (untagged) drop falls back to a directory lookup', async () => {
    markTauri();
    invokeMock.mockResolvedValue({ status: 'unique', path: '/Users/user/overlay-lab' });

    const dir = new File([], 'overlay-lab');
    vi.spyOn(dir, 'arrayBuffer').mockRejectedValue(new DOMException('NotReadableError'));
    const result = await resolveDroppedFilePath(dir);

    expect(invokeMock).toHaveBeenCalledWith('resolve_dropped_file_path', {
      name: 'overlay-lab',
      size: 0,
      contentHash: '',
      isDirectory: true,
    });
    expect(result).toEqual({ status: 'unique', path: '/Users/user/overlay-lab' });
  });

  it('passes through an ambiguous resolution unchanged', async () => {
    markTauri();
    invokeMock.mockResolvedValue({ status: 'ambiguous', candidates: ['/a', '/b'] });

    const result = await resolveDroppedFilePath(new File(['x'], 'x.txt'));
    expect(result).toEqual({ status: 'ambiguous', candidates: ['/a', '/b'] });
  });

  it('passes through a not_found resolution unchanged', async () => {
    markTauri();
    invokeMock.mockResolvedValue({ status: 'not_found' });

    const result = await resolveDroppedFilePath(new File(['x'], 'x.txt'));
    expect(result).toEqual({ status: 'not_found' });
  });

  it('a failing invoke resolves to not_found instead of throwing', async () => {
    markTauri();
    invokeMock.mockRejectedValue(new Error('command not registered'));

    const result = await resolveDroppedFilePath(new File(['x'], 'x.txt'));
    expect(result).toEqual({ status: 'not_found' });
  });
});
