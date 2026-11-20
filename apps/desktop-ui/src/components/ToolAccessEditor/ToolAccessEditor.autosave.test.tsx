/**
 * ToolAccessEditor — pins the opt-in `autosave` contract used by the agent
 * detail pane: mutations persist through a short debounce (no Save button), a
 * burst of toggles coalesces into a single write, and a failed save keeps the
 * pending config. The default manual-Save path is left intact. (Grouping
 * behavior lives in ToolAccessEditor.test.tsx.)
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolAccessConfig } from '@snaglet/shared/types';
import { ToolAccessEditor, type ToolOption } from './ToolAccessEditor';

const tools: ToolOption[] = [
  { id: 'read', name: 'Read', categoryPath: 'fs' },
  { id: 'write', name: 'Write', categoryPath: 'fs' },
];

const allowMode: ToolAccessConfig = { mode: 'allow_list', allowList: [], denyList: [] };

const advance = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ToolAccessEditor — autosave mode', () => {
  it('has no Save button and persists a toggle after the debounce', async () => {
    const onSave = vi.fn(async () => {});
    render(<ToolAccessEditor value={allowMode} tools={tools} onSave={onSave} autosave />);

    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: /read/i }));
    expect(onSave).not.toHaveBeenCalled();

    await advance(500);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      mode: 'allow_list',
      allowList: ['read'],
      denyList: [],
    });
  });

  it('coalesces a burst of toggles into a single write', async () => {
    const onSave = vi.fn(async () => {});
    render(<ToolAccessEditor value={allowMode} tools={tools} onSave={onSave} autosave />);

    fireEvent.click(screen.getByRole('checkbox', { name: /read/i }));
    await advance(200);
    fireEvent.click(screen.getByRole('checkbox', { name: /write/i }));
    await advance(500);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      mode: 'allow_list',
      allowList: ['read', 'write'],
      denyList: [],
    });
  });

  it('keeps the pending config and surfaces the error when a save fails', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('boom');
    });
    render(<ToolAccessEditor value={allowMode} tools={tools} onSave={onSave} autosave />);

    fireEvent.click(screen.getByRole('checkbox', { name: /read/i }));
    await advance(500);

    expect(screen.getByText('boom')).toBeTruthy();
    // The toggle stays applied — the user's change isn't reverted on failure.
    expect((screen.getByRole('checkbox', { name: /read/i }) as HTMLInputElement).checked).toBe(
      true
    );
  });
});

describe('ToolAccessEditor — manual mode (default) is unchanged', () => {
  it('renders a Save button and does not auto-persist on toggle', async () => {
    const onSave = vi.fn(async () => {});
    render(<ToolAccessEditor value={allowMode} tools={tools} onSave={onSave} />);

    expect(screen.getByRole('button', { name: /save/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: /read/i }));
    await advance(1000);

    expect(onSave).not.toHaveBeenCalled();
  });
});
