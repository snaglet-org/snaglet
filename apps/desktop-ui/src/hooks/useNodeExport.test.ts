/**
 * useNodeExport — the environment split.
 *
 * Tauri writes through the server; the browser gets bytes and the server
 * touches nothing. The interesting cases are the ones that are easy to report
 * wrongly: a canceled dialog, and a file the server renamed to avoid a
 * collision.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const isTauriEnv = vi.fn();
const write = vi.fn();
const download = vi.fn();
const pickFolder = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@desktop/utils/tauriEnv.js', () => ({ isTauriEnv: () => isTauriEnv() }));
vi.mock('@desktop/utils/api/export.js', () => ({
  exportApi: {
    write: (...a: unknown[]) => write(...a),
    download: (...a: unknown[]) => download(...a),
  },
}));
vi.mock('@desktop/socket/index.js', () => ({
  socketClient: { pickFolder: (...a: unknown[]) => pickFolder(...a) },
}));

import { splitPath, useNodeExport } from './useNodeExport';

const DOC = { kind: 'doc' as const, id: 'doc-1', suggestedName: 'Notes.md' };

beforeEach(() => {
  vi.clearAllMocks();
  isTauriEnv.mockReturnValue(true);
  pickFolder.mockResolvedValue('/home/user/Desktop');
  invoke.mockResolvedValue({
    path: '/home/user/Desktop/Notes.md',
    overwriteGrant: '1800000000000.abcd.mac',
  });
  write.mockResolvedValue({
    kind: 'doc',
    id: 'doc-1',
    fileName: 'Notes.md',
    bytes: 10,
    path: '/home/user/Desktop/Notes.md',
    overwritten: false,
    downloaded: false,
  });
});

describe('container folder export', () => {
  const report = {
    schemaVersion: 1 as const,
    container: { id: 'container-1', name: 'Planning' },
    exportedAt: '2026-08-05T00:00:00.000Z',
    exportedBy: 'Test User',
    snagletVersion: '0.1.0',
    exported: [],
    skipped: [],
    failed: [],
    summary: { containers: 1, docs: 0, skipped: 0, failed: 0 },
  };

  beforeEach(() => {
    write.mockResolvedValue({
      kind: 'container',
      id: 'container-1',
      fileName: 'Planning',
      bytes: 50,
      path: '/home/user/Desktop/Planning',
      manifestPath: '/home/user/Desktop/Planning/export-manifest.json',
      report,
      overwritten: false,
      downloaded: false,
    });
  });

  it('chooses one folder and sends one recursive server request', async () => {
    const { result } = renderHook(() => useNodeExport());

    await act(async () => {
      await result.current.exportNode({ kind: 'container', id: 'container-1' });
    });

    expect(pickFolder).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({
      kind: 'container',
      id: 'container-1',
      destDir: '/home/user/Desktop',
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({
      status: 'container-written',
      path: '/home/user/Desktop/Planning',
      directoryName: 'Planning',
      manifestPath: '/home/user/Desktop/Planning/export-manifest.json',
      report,
    });
  });

  it('treats canceling the folder picker as neutral and writes nothing', async () => {
    pickFolder.mockResolvedValue(null);
    const { result } = renderHook(() => useNodeExport());

    await act(async () => {
      await result.current.exportNode({ kind: 'container', id: 'container-1' });
    });

    expect(result.current.state).toEqual({ status: 'canceled' });
    expect(write).not.toHaveBeenCalled();
  });

  it('fails truthfully when the server omits the required completion report', async () => {
    write.mockResolvedValue({
      kind: 'container',
      id: 'container-1',
      fileName: 'Planning',
      bytes: 0,
      path: '/home/user/Desktop/Planning',
      overwritten: false,
      downloaded: false,
    });
    const { result } = renderHook(() => useNodeExport());

    await act(async () => {
      await result.current.exportNode({ kind: 'container', id: 'container-1' });
    });

    expect(result.current.state).toMatchObject({ status: 'error', message: /completion report/i });
  });
});

describe('splitPath', () => {
  it('splits a posix path', () => {
    expect(splitPath('/home/user/Desktop/Notes.md')).toEqual({
      dir: '/home/user/Desktop',
      name: 'Notes.md',
    });
  });

  it('splits a windows path', () => {
    expect(splitPath('C:\\Users\\user\\Notes.md')).toEqual({
      dir: 'C:\\Users\\user',
      name: 'Notes.md',
    });
  });

  it('keeps root as a directory rather than an empty string', () => {
    expect(splitPath('/Notes.md')).toEqual({ dir: '/', name: 'Notes.md' });
  });
});

describe('Tauri path', () => {
  it('sends the directory and filename separately, never a single file path', async () => {
    const { result } = renderHook(() => useNodeExport());

    await act(async () => {
      await result.current.exportNode(DOC);
    });

    // The server guards a directory; a not-yet-created file has no realpath.
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ destDir: '/home/user/Desktop', fileName: 'Notes.md' })
    );
    const [body] = write.mock.calls[0] as [Record<string, unknown>];
    expect(body).not.toHaveProperty('path');
  });

  it('forwards the grant the shell minted, and never a boolean', async () => {
    const { result } = renderHook(() => useNodeExport());
    await act(async () => {
      await result.current.exportNode(DOC);
    });

    const [body] = write.mock.calls[0] as [{ options?: Record<string, unknown> }];
    expect(body.options?.overwriteGrant).toBe('1800000000000.abcd.mac');
    // A boolean would be something the UI could assert on its own, which is
    // exactly what must not be able to authorize an overwrite.
    expect(body.options?.overwrite).toBeUndefined();
  });

  it('sends no grant when the shell had no key to sign with', async () => {
    // Dev builds without the packaged sidecar: no grant, so no-clobber.
    invoke.mockResolvedValue({ path: '/home/user/Desktop/Notes.md' });
    const { result } = renderHook(() => useNodeExport());

    await act(async () => {
      await result.current.exportNode(DOC);
    });

    const [body] = write.mock.calls[0] as [{ options?: Record<string, unknown> }];
    expect(body.options?.overwriteGrant).toBeUndefined();
  });

  it('reports the path the server actually wrote', async () => {
    const { result } = renderHook(() => useNodeExport());
    await act(async () => {
      await result.current.exportNode(DOC);
    });
    expect(result.current.state).toEqual({
      status: 'written',
      path: '/home/user/Desktop/Notes.md',
      fileName: 'Notes.md',
      renamed: false,
    });
  });

  it('flags a rename when the server avoided a collision', async () => {
    write.mockResolvedValue({
      fileName: 'Notes (2).md',
      path: '/home/user/Desktop/Notes (2).md',
      bytes: 10,
      kind: 'doc',
      id: 'doc-1',
      overwritten: false,
      downloaded: false,
    });
    const { result } = renderHook(() => useNodeExport());

    await act(async () => {
      await result.current.exportNode(DOC);
    });

    // Reporting the requested name here would send the user to a file that
    // does not exist.
    expect(result.current.state).toMatchObject({ renamed: true, fileName: 'Notes (2).md' });
  });

  it('treats a dismissed dialog as canceled, not an error', async () => {
    invoke.mockResolvedValue(null);
    const { result } = renderHook(() => useNodeExport());

    await act(async () => {
      await result.current.exportNode(DOC);
    });

    expect(result.current.state).toEqual({ status: 'canceled' });
    expect(write).not.toHaveBeenCalled();
  });

  it('forwards a thread message limit', async () => {
    const { result } = renderHook(() => useNodeExport());
    await act(async () => {
      await result.current.exportNode({
        kind: 'thread',
        id: 'thread-1',
        suggestedName: 'T.md',
        messageLimit: 500,
      });
    });
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ messageLimit: 500 }) })
    );
  });

  it('surfaces a guard rejection from the server', async () => {
    write.mockRejectedValue(new Error("Refusing to export into Snaglet's own storage"));
    const { result } = renderHook(() => useNodeExport());

    await act(async () => {
      await result.current.exportNode(DOC);
    });

    expect(result.current.state).toMatchObject({
      status: 'error',
      message: expect.stringContaining('own storage'),
    });
  });

  it('ignores a second click while a dialog is already open', async () => {
    let release!: (v: { path: string }) => void;
    invoke.mockReturnValue(
      new Promise<{ path: string }>((r) => {
        release = r;
      })
    );
    const { result } = renderHook(() => useNodeExport());

    let first!: Promise<void>;
    act(() => {
      first = result.current.exportNode(DOC);
    });
    await act(async () => {
      await result.current.exportNode(DOC);
    });

    // A second native sheet stacked on the first is unrecoverable on macOS.
    expect(invoke).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ path: '/home/user/Desktop/Notes.md' });
      await first;
    });
  });
});

describe('browser path', () => {
  /** `download` attribute values from every anchor click this test made. */
  let clicked: string[];

  beforeEach(() => {
    isTauriEnv.mockReturnValue(false);
    download.mockResolvedValue({ blob: new Blob(['x']), fileName: 'Notes.md' });
    // jsdom does not implement object URLs.
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:x'), writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), writable: true });

    // Neutralize the anchor's real click. jsdom treats it as navigation and
    // logs "Not implemented: navigation to another Document" — noise that
    // would sit permanently next to green tests and mask a real warning.
    clicked = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag === 'a') {
        (el as HTMLAnchorElement).click = () => clicked.push((el as HTMLAnchorElement).download);
      }
      return el;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks for bytes and never for a write', async () => {
    const { result } = renderHook(() => useNodeExport());

    await act(async () => {
      await result.current.exportNode(DOC);
    });

    expect(download).toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    // No dialog exists in a browser; invoking Tauri here would throw.
    expect(invoke).not.toHaveBeenCalled();
  });

  it('sends no destDir, which is what stops the server writing', async () => {
    const { result } = renderHook(() => useNodeExport());
    await act(async () => {
      await result.current.exportNode(DOC);
    });
    const [body] = download.mock.calls[0] as [Record<string, unknown>];
    expect(body.destDir).toBeUndefined();
  });

  it('reports a download with no path, because there is none', async () => {
    const { result } = renderHook(() => useNodeExport());
    await act(async () => {
      await result.current.exportNode(DOC);
    });
    expect(result.current.state).toEqual({ status: 'downloaded', fileName: 'Notes.md' });
  });

  it('uses the server filename for the download attribute', async () => {
    const { result } = renderHook(() => useNodeExport());

    await act(async () => {
      await result.current.exportNode(DOC);
    });

    // The server's name wins: it applied the authoritative extension.
    expect(clicked).toEqual(['Notes.md']);
  });

  it('surfaces a download failure', async () => {
    download.mockRejectedValue(new Error('Doc not found: doc-1'));
    const { result } = renderHook(() => useNodeExport());

    await act(async () => {
      await result.current.exportNode(DOC);
    });

    await waitFor(() =>
      expect(result.current.state).toMatchObject({ status: 'error', message: /not found/ })
    );
  });
});

describe('reset', () => {
  it('clears a previous outcome', async () => {
    const { result } = renderHook(() => useNodeExport());
    await act(async () => {
      await result.current.exportNode(DOC);
    });
    expect(result.current.state.status).toBe('written');

    act(() => result.current.reset());

    expect(result.current.state).toEqual({ status: 'idle' });
  });
});
