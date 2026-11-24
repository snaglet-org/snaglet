/**
 * ToolAccessEditor — deny entries outside deny-list mode.
 *
 * Switching mode keeps both lists, and the server reads the deny list in
 * every mode: the permission engine and chat dispatch refuse whatever a deny
 * entry matches (deny > allow), in allow-list and All mode alike. Those
 * entries show under "Also blocked (deny list)", each removable on its own.
 * Allow entries in deny-list mode apply nowhere, so they are not shown.
 * Opening the editor saves nothing.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolAccessConfig, ToolAccessMode } from '@snaglet/shared/types';
import { ToolAccessEditor, type ToolOption } from './ToolAccessEditor';

// Shell and the clock carry their real definition names.
const TOOLS: ToolOption[] = [
  { id: 'shell', name: 'Shell', categoryPath: 'shell', aliases: ['terminal', 'bash'] },
  { id: 'search', name: 'Search', categoryPath: 'search', aliases: [] },
  {
    id: 'get_current_datetime',
    name: 'Get Current Date & Time',
    categoryPath: 'system',
    aliases: ['now', 'today', 'current_time', 'current_datetime'],
  },
];

const config = (
  mode: ToolAccessMode,
  allowList: string[],
  denyList: string[]
): ToolAccessConfig => ({ mode, allowList, denyList });

const alsoBlocked = () => screen.queryByRole('group', { name: 'Also blocked (deny list)' });
const box = (name: RegExp) => screen.getByRole('checkbox', { name }) as HTMLInputElement;

const advance = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ToolAccessEditor — Also blocked (deny list)', () => {
  it('shows a stored deny entry in allow-list mode, with the tool it blocks', () => {
    render(
      <ToolAccessEditor
        value={config('allow_list', ['shell', 'search'], ['shell'])}
        tools={TOOLS}
        onSave={vi.fn()}
      />
    );

    const group = alsoBlocked()!;
    expect(within(group).getByText('shell')).toBeInTheDocument();
    expect(within(group).getByText('blocks Shell')).toHaveAttribute(
      'title',
      expect.stringContaining('still applies in allow-list mode')
    );
    // The allow list itself reads as before.
    expect(box(/^shell/i).checked).toBe(true);
  });

  it('removes only that entry from the deny list; opening saves nothing', async () => {
    const onSave = vi.fn(async () => {});
    render(
      <ToolAccessEditor
        value={config('allow_list', ['shell'], ['shell', 'bash(rm:*)'])}
        tools={TOOLS}
        onSave={onSave}
        autosave
      />
    );

    await advance(1000);
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove shell from the deny list' }));
    await advance(500);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(config('allow_list', ['shell'], ['bash(rm:*)']));
    expect(within(alsoBlocked()!).queryByText('blocks Shell')).toBeNull();
    expect(within(alsoBlocked()!).getByText('blocks Shell · rm:*')).toBeInTheDocument();
  });

  it('reads every kind of deny entry as the main list does', () => {
    render(
      <ToolAccessEditor
        value={config(
          'allow_list',
          [],
          ['bash(rm:*)', 'exec_command', 'sandbox_run', 'mcp__off__tool', 'now', ' shell ', 'shell']
        )}
        tools={TOOLS}
        onSave={vi.fn()}
      />
    );

    const group = alsoBlocked()!;
    expect(within(group).getByText('blocks Shell · rm:*')).toBeInTheDocument();
    // An old id pins its op.
    expect(within(group).getByText('blocks Shell · ops: run')).toBeInTheDocument();
    expect(within(group).getByText('removed from Snaglet')).toBeInTheDocument();
    expect(within(group).getByText('MCP tool not connected')).toBeInTheDocument();
    expect(within(group).getByText('has no effect — always available')).toBeInTheDocument();
    // A padded copy shares its entry's row.
    expect(within(group).getAllByText('shell')).toHaveLength(1);
    expect(within(group).getAllByRole('button')).toHaveLength(6);
  });

  it('shows nothing from the other list in deny-list mode, and keeps the allow list', async () => {
    const onSave = vi.fn(async () => {});
    render(
      <ToolAccessEditor
        value={config('deny_list', ['shell', 'search'], ['search'])}
        tools={TOOLS}
        onSave={onSave}
        autosave
      />
    );

    expect(alsoBlocked()).toBeNull();
    // Shell is only on the inactive allow list: not shown as active.
    expect(box(/^shell/i).checked).toBe(false);
    expect(box(/^search/i).checked).toBe(true);

    fireEvent.click(box(/^search/i));
    await advance(500);

    expect(onSave).toHaveBeenCalledWith(config('deny_list', ['shell', 'search'], []));
  });

  it('in All mode shows every deny entry, read as the server applies it', () => {
    render(
      <ToolAccessEditor
        value={config(
          'all',
          ['search'],
          ['bash', 'shell(rm -rf:*)', 'exec_command', 'sandbox_run', 'now', 'Search']
        )}
        tools={TOOLS}
        onSave={vi.fn()}
      />
    );

    const group = alsoBlocked()!;
    expect(within(group).getByText('bash')).toBeInTheDocument();
    expect(within(group).getByText('blocks Shell')).toHaveAttribute(
      'title',
      expect.stringContaining('All mode still refuses Shell when an agent calls it')
    );
    expect(within(group).getByText('Search')).toBeInTheDocument();
    expect(within(group).getByText('blocks Search')).toBeInTheDocument();
    // A command rule and an old id block what they match, in All mode too.
    expect(within(group).getByText('shell(rm -rf:*)')).toBeInTheDocument();
    expect(within(group).getByText('blocks Shell · rm -rf:*')).toHaveAttribute(
      'title',
      expect.stringContaining('All mode still refuses Shell calls this entry matches')
    );
    expect(within(group).getByText('blocks Shell · ops: run')).toBeInTheDocument();
    // An entry with no effect says why, as in allow-list mode.
    expect(within(group).getByText('removed from Snaglet')).toBeInTheDocument();
    expect(within(group).getByText('has no effect — always available')).toBeInTheDocument();
    expect(screen.getByText(/except what the deny list below still blocks/i)).toBeInTheDocument();
  });

  it('removes an entry in All mode and keeps the rest as stored', async () => {
    const onSave = vi.fn(async () => {});
    render(
      <ToolAccessEditor
        value={config('all', ['search'], ['bash', 'shell(rm:*)'])}
        tools={TOOLS}
        onSave={onSave}
        autosave
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove bash from the deny list' }));
    await advance(500);

    expect(onSave).toHaveBeenCalledWith(config('all', ['search'], ['shell(rm:*)']));
    expect(within(alsoBlocked()!).queryByText('bash')).toBeNull();
    expect(within(alsoBlocked()!).getByText('blocks Shell · rm:*')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove shell(rm:*) from the deny list' }));
    await advance(500);

    expect(onSave).toHaveBeenLastCalledWith(config('all', ['search'], []));
    expect(alsoBlocked()).toBeNull();
    expect(screen.getByText(/^All tools are callable\./)).toBeInTheDocument();
  });

  it('shows no group in All mode when the deny list is empty', () => {
    render(
      <ToolAccessEditor value={config('all', ['shell'], [])} tools={TOOLS} onSave={vi.fn()} />
    );

    expect(alsoBlocked()).toBeNull();
  });

  it('waits for the tool list before reading deny entries', () => {
    render(
      <ToolAccessEditor value={config('allow_list', [], ['shell'])} tools={[]} onSave={vi.fn()} />
    );

    expect(alsoBlocked()).toBeNull();
  });
});
