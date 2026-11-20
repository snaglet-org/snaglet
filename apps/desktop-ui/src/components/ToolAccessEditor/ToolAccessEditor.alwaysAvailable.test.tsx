/**
 * ToolAccessEditor — the always-available tools.
 *
 * The server never gates `search_tools` or `get_current_datetime` by an allow
 * or deny entry (shared ALWAYS_AVAILABLE_TOOL_IDS). The editor agrees: their
 * rows are locked (on in allow-list mode, off in deny-list mode), it never
 * adds an entry for them, and a stored entry naming them by any name reads
 * "has no effect — always available" with a remove button.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolAccessConfig } from '@snaglet/shared/types';
import { ToolAccessEditor, type ToolOption } from './ToolAccessEditor';

// The clock carries its real definition names (get-current-datetime/definition.ts).
const TOOLS: ToolOption[] = [
  { id: 'tool', name: 'Tools', categoryPath: 'system', aliases: [] },
  {
    id: 'get_current_datetime',
    name: 'Get Current Date & Time',
    categoryPath: 'system',
    aliases: ['now', 'today', 'current_time', 'current_datetime'],
  },
  { id: 'search', name: 'Search', categoryPath: 'search', aliases: [] },
];

const allow = (...allowList: string[]): ToolAccessConfig => ({
  mode: 'allow_list',
  allowList,
  denyList: [],
});

const deny = (...denyList: string[]): ToolAccessConfig => ({
  mode: 'deny_list',
  allowList: [],
  denyList,
});

const box = (name: RegExp) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
const searchToolsBox = () => box(/^tools/i);
const clockBox = () => box(/^get current date/i);
const rowEntries = (toolName: string) =>
  screen.queryByRole('group', { name: `Entries for ${toolName}` });
const unmatchedGroup = () => screen.queryByRole('group', { name: 'Not in the tool list' });

const advance = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ToolAccessEditor — always-available tools', () => {
  it('locks search and the clock on in allow-list mode, with a hint', () => {
    render(<ToolAccessEditor value={allow('search')} tools={TOOLS} onSave={vi.fn()} />);

    for (const input of [searchToolsBox(), clockBox()]) {
      expect(input.checked).toBe(true);
      expect(input.disabled).toBe(true);
    }
    expect(screen.getByTestId('always-available-tool')).toHaveTextContent('always available');
    expect(searchToolsBox().closest('label')).toHaveAttribute(
      'title',
      expect.stringContaining('to find tools and tell the time')
    );
    // An ordinary tool is unaffected.
    expect(box(/^search(?! tools)/i).disabled).toBe(false);
  });

  it('locks them off in deny-list mode', () => {
    render(<ToolAccessEditor value={deny()} tools={TOOLS} onSave={vi.fn()} />);

    for (const input of [searchToolsBox(), clockBox()]) {
      expect(input.checked).toBe(false);
      expect(input.disabled).toBe(true);
    }
  });

  it('never adds an entry for them', async () => {
    const onSave = vi.fn(async () => {});
    render(<ToolAccessEditor value={deny()} tools={TOOLS} onSave={onSave} autosave />);

    fireEvent.click(searchToolsBox());
    fireEvent.click(clockBox().closest('label')!);
    await advance(1000);

    expect(onSave).not.toHaveBeenCalled();
    expect(searchToolsBox().checked).toBe(false);
  });

  it('shows stored deny entries naming them, by any name, as having no effect', () => {
    render(
      <ToolAccessEditor
        value={deny('search_tools', 'now', 'Get Current Date & Time')}
        tools={TOOLS}
        onSave={vi.fn()}
      />
    );

    expect(searchToolsBox().checked).toBe(false);
    expect(clockBox().checked).toBe(false);
    const search = rowEntries('Tools')!;
    expect(within(search).getByText('search_tools')).toBeInTheDocument();
    expect(within(search).getByText('has no effect — always available')).toHaveAttribute(
      'title',
      expect.stringContaining('Tools is always available')
    );
    const clock = rowEntries('Get Current Date & Time')!;
    expect(within(clock).getByText('now')).toBeInTheDocument();
    expect(within(clock).getByText('Get Current Date & Time')).toBeInTheDocument();
    expect(within(clock).getAllByText('has no effect — always available')).toHaveLength(2);
    expect(unmatchedGroup()).toBeNull();
  });

  it('removes only the entry whose x is clicked; opening saves nothing', async () => {
    const onSave = vi.fn(async () => {});
    render(
      <ToolAccessEditor
        value={deny('search', 'now', 'search_tools')}
        tools={TOOLS}
        onSave={onSave}
        autosave
      />
    );

    await advance(1000);
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove now' }));
    await advance(500);

    expect(onSave).toHaveBeenCalledWith(deny('search', 'search_tools'));
  });

  it('shows allow entries naming them, old ids included, and removes them', async () => {
    const onSave = vi.fn(async () => {});
    render(
      <ToolAccessEditor
        value={allow('get_current_datetime', 'list_tools', 'search')}
        tools={TOOLS}
        onSave={onSave}
        autosave
      />
    );

    expect(
      within(rowEntries('Get Current Date & Time')!).getByText('get_current_datetime')
    ).toBeInTheDocument();
    expect(within(rowEntries('Tools')!).getByText('list_tools')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove list_tools' }));
    await advance(500);

    expect(onSave).toHaveBeenCalledWith(allow('get_current_datetime', 'search'));
  });

  it('lists an entry for an always-available tool missing from the list under the group', () => {
    const withoutClock = TOOLS.filter((t) => t.id !== 'get_current_datetime');
    render(<ToolAccessEditor value={deny('date_time')} tools={withoutClock} onSave={vi.fn()} />);

    const group = unmatchedGroup()!;
    expect(within(group).getByText('date_time')).toBeInTheDocument();
    expect(within(group).getByText('has no effect — always available')).toBeInTheDocument();
  });
});
