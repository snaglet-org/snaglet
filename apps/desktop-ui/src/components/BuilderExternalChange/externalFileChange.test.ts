/**
 * External-change detection for the builder editors.
 *
 * The property under test throughout: an edit the user has not saved is never
 * lost without them being asked, and a file that moved on disk is never
 * overwritten by a buffer that never saw it.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyExternalChange, useExternalFileChange } from './externalFileChange';

const BASELINE = 'export default 1;\n';
const DISK = 'export default 2; // agent wrote this\n';
const MINE = 'export default 3; // I typed this\n';

describe('classifyExternalChange', () => {
  it('reports unchanged when disk still matches the loaded baseline', () => {
    expect(classifyExternalChange(BASELINE, BASELINE, BASELINE)).toBe('unchanged');
    // Still unchanged even with unsaved edits — nothing external happened.
    expect(classifyExternalChange(BASELINE, BASELINE, MINE)).toBe('unchanged');
  });

  it('refreshes a clean buffer', () => {
    expect(classifyExternalChange(DISK, BASELINE, BASELINE)).toBe('refresh');
  });

  it('converges when the unsaved edits happen to equal what landed on disk', () => {
    expect(classifyExternalChange(DISK, BASELINE, DISK)).toBe('converged');
  });

  it('conflicts only when a dirty buffer genuinely disagrees with disk', () => {
    expect(classifyExternalChange(DISK, BASELINE, MINE)).toBe('conflict');
  });
});

describe('useExternalFileChange', () => {
  const read = vi.fn();
  const onAdopt = vi.fn();
  const onRebaseline = vi.fn();

  const setup = (overrides: { buffer?: string; enabled?: boolean } = {}) =>
    renderHook(() =>
      useExternalFileChange({
        enabled: overrides.enabled ?? true,
        read,
        baseline: BASELINE,
        buffer: overrides.buffer ?? BASELINE,
        onAdopt,
        onRebaseline,
      })
    );

  beforeEach(() => {
    read.mockReset().mockResolvedValue(BASELINE);
    onAdopt.mockReset();
    onRebaseline.mockReset();
  });

  it('adopts the new file silently when the buffer is clean', async () => {
    read.mockResolvedValue(DISK);
    const { result } = setup({ buffer: BASELINE });

    await act(async () => {
      await result.current.check();
    });

    expect(onAdopt).toHaveBeenCalledWith(DISK);
    expect(result.current.conflict).toBeNull();
  });

  it('raises a conflict, and never adopts, when the buffer is dirty', async () => {
    read.mockResolvedValue(DISK);
    const { result } = setup({ buffer: MINE });

    await act(async () => {
      await result.current.check();
    });

    expect(result.current.conflict).toEqual({ disk: DISK });
    expect(onAdopt).not.toHaveBeenCalled();
    expect(onRebaseline).not.toHaveBeenCalled();
  });

  it('re-baselines without asking when the dirty buffer already matches disk', async () => {
    read.mockResolvedValue(DISK);
    const { result } = setup({ buffer: DISK });

    await act(async () => {
      await result.current.check();
    });

    expect(onRebaseline).toHaveBeenCalledWith(DISK);
    expect(result.current.conflict).toBeNull();
  });

  it('reports unavailable — not unchanged — when the file cannot be re-read', async () => {
    read.mockRejectedValue(new Error('network down'));
    const { result } = setup({ buffer: MINE });

    let verdict: string | undefined;
    await act(async () => {
      verdict = await result.current.check();
    });

    // Saying "unchanged" here would be a claim the code has no basis for.
    expect(verdict).toBe('unavailable');
    expect(onAdopt).not.toHaveBeenCalled();
    expect(onRebaseline).not.toHaveBeenCalled();
  });

  it('keeps a standing conflict when a later re-read fails', async () => {
    read.mockResolvedValue(DISK);
    const { result } = setup({ buffer: MINE });
    await act(async () => {
      await result.current.check();
    });
    expect(result.current.conflict).not.toBeNull();

    read.mockRejectedValue(new Error('network down'));
    await act(async () => {
      await result.current.check();
    });

    expect(result.current.conflict).toEqual({ disk: DISK });
  });

  it('keepMine re-baselines to disk but leaves the buffer alone', async () => {
    read.mockResolvedValue(DISK);
    const { result } = setup({ buffer: MINE });
    await act(async () => {
      await result.current.check();
    });

    act(() => result.current.keepMine());

    // Re-baselining is what makes the next save a deliberate overwrite rather
    // than a blocked one — the buffer itself is untouched.
    expect(onRebaseline).toHaveBeenCalledWith(DISK);
    expect(onAdopt).not.toHaveBeenCalled();
    expect(result.current.conflict).toBeNull();
  });

  it('reloadFromDisk adopts the disk copy and drops the edits', async () => {
    read.mockResolvedValue(DISK);
    const { result } = setup({ buffer: MINE });
    await act(async () => {
      await result.current.check();
    });

    act(() => result.current.reloadFromDisk());

    expect(onAdopt).toHaveBeenCalledWith(DISK);
    expect(onRebaseline).not.toHaveBeenCalled();
    expect(result.current.conflict).toBeNull();
  });

  it('clears the conflict when the file returns to the baseline on its own', async () => {
    read.mockResolvedValue(DISK);
    const { result } = setup({ buffer: MINE });
    await act(async () => {
      await result.current.check();
    });
    expect(result.current.conflict).not.toBeNull();

    read.mockResolvedValue(BASELINE);
    await act(async () => {
      await result.current.check();
    });

    expect(result.current.conflict).toBeNull();
  });

  it('shows the newest disk copy when it changes again while the prompt is up', async () => {
    read.mockResolvedValue(DISK);
    const { result } = setup({ buffer: MINE });
    await act(async () => {
      await result.current.check();
    });

    const newer = `${DISK}// and again\n`;
    read.mockResolvedValue(newer);
    await act(async () => {
      await result.current.check();
    });

    // The text on screen and the text the buttons act on must be one snapshot.
    expect(result.current.conflict).toEqual({ disk: newer });
    act(() => result.current.reloadFromDisk());
    expect(onAdopt).toHaveBeenCalledWith(newer);
  });

  it('re-checks when the window regains focus', async () => {
    read.mockResolvedValue(DISK);
    const { result } = setup({ buffer: MINE });

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(result.current.conflict).toEqual({ disk: DISK }));
  });

  it('does not watch a file it has no business watching', async () => {
    const { result } = setup({ enabled: false, buffer: MINE });

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    let verdict: string | undefined;
    await act(async () => {
      verdict = await result.current.check();
    });

    expect(read).not.toHaveBeenCalled();
    expect(verdict).toBe('unchanged');
  });

  it('stops listening once unmounted', async () => {
    read.mockResolvedValue(DISK);
    const { unmount } = setup({ buffer: MINE });
    unmount();

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(read).not.toHaveBeenCalled();
  });

  it('sees the current buffer, not the one from the render that subscribed', async () => {
    read.mockResolvedValue(DISK);
    const { result, rerender } = renderHook(
      ({ buffer }: { buffer: string }) =>
        useExternalFileChange({
          enabled: true,
          read,
          baseline: BASELINE,
          buffer,
          onAdopt,
          onRebaseline,
        }),
      { initialProps: { buffer: BASELINE } }
    );

    // The user types after the listener was installed. A stale closure would
    // still think the buffer is clean and adopt over their work.
    rerender({ buffer: MINE });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(result.current.conflict).toEqual({ disk: DISK }));
    expect(onAdopt).not.toHaveBeenCalled();
  });
});
