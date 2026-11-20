/**
 * ToolAccessEditor — stored entries that name no current tool id.
 *
 * A tool's other names show on it where the server reads them as that tool:
 * `deny: bash` blocks shell, so it shows on Shell with a "saved as bash" hint.
 * `allow: bash` allows nothing, and removed or unknown ids (`sandbox_run`,
 * `database_*`) match no tool; those list under "Not in the tool list" with a
 * remove control. Nothing is rewritten until the person removes an entry.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolAccessConfig } from '@snaglet/shared/types';
import { ToolAccessEditor, type ToolOption } from './ToolAccessEditor';

// Shell carries its real definition names (shell/definition.ts).
const TOOLS: ToolOption[] = [
  { id: 'shell', name: 'Shell', categoryPath: 'shell', aliases: ['terminal', 'bash'] },
  { id: 'search', name: 'Search', categoryPath: 'search', aliases: [] },
  { id: 'table', name: 'Table', categoryPath: 'database', aliases: ['table_read'] },
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

describe('ToolAccessEditor — definition names', () => {
  it('shows deny: bash on Shell as blocking the whole tool, with a hint', () => {
    render(<ToolAccessEditor value={deny('bash')} tools={TOOLS} onSave={vi.fn()} />);

    expect(box(/^shell/i).checked).toBe(true);
    expect(screen.getByTestId('other-names-shell')).toHaveTextContent('saved as bash');
    expect(screen.queryByTestId('scoped-ops-shell')).toBeNull();
    expect(screen.getByText(/blocked entirely/i)).toBeInTheDocument();
    expect(unmatchedGroup()).toBeNull();
  });

  it('matches a definition name in any case, as the server does', () => {
    render(<ToolAccessEditor value={deny('Bash')} tools={TOOLS} onSave={vi.fn()} />);

    expect(box(/^shell/i).checked).toBe(true);
    expect(screen.getByTestId('other-names-shell')).toHaveTextContent('saved as Bash');
  });

  it('unchecking Shell removes a stored deny: bash; opening alone saves nothing', async () => {
    const onSave = vi.fn(async () => {});
    render(
      <ToolAccessEditor value={deny('bash', 'search')} tools={TOOLS} onSave={onSave} autosave />
    );

    await advance(1000);
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(box(/^shell/i));
    await advance(500);

    expect(onSave).toHaveBeenCalledWith(deny('search'));
  });

  it('shows a deny rule under a definition name as a chip on Shell, and removes it', async () => {
    const onSave = vi.fn(async () => {});
    render(
      <ToolAccessEditor
        value={deny('bash(rm:*)', 'shell(git push:*)')}
        tools={TOOLS}
        onSave={onSave}
        autosave
      />
    );

    expect(box(/^shell/i).checked).toBe(true);
    const chip = screen.getByText('rm:*').closest('span[title]');
    expect(chip).toHaveAttribute('title', 'Saved as bash(rm:*)');

    fireEvent.click(screen.getByRole('button', { name: 'Remove rule rm:*' }));
    await advance(500);

    expect(onSave).toHaveBeenCalledWith(deny('shell(git push:*)'));
  });

  it('a definition name that is an old id keeps its pins, not the name rule', () => {
    render(<ToolAccessEditor value={deny('table_read')} tools={TOOLS} onSave={vi.fn()} />);

    expect(screen.getByTestId('scoped-ops-table')).toHaveTextContent(/^ops: read$/);
    expect(screen.getByTestId('old-ids-table')).toHaveTextContent('was table_read');
    expect(screen.queryByTestId('other-names-table')).toBeNull();
  });

  it('shows allow: bash as allowing nothing, never as Shell, and lets it be removed', async () => {
    const onSave = vi.fn(async () => {});
    render(
      <ToolAccessEditor value={allow('bash', 'search')} tools={TOOLS} onSave={onSave} autosave />
    );

    expect(box(/^shell/i).checked).toBe(false);
    const group = unmatchedGroup()!;
    expect(within(group).getByText('bash')).toBeInTheDocument();
    expect(within(group).getByText('allows nothing')).toHaveAttribute(
      'title',
      expect.stringContaining('another name for Shell')
    );

    fireEvent.click(within(group).getByRole('button', { name: 'Remove bash' }));
    await advance(500);

    expect(onSave).toHaveBeenCalledWith(allow('search'));
  });

  it('checking Shell next to allow: bash adds shell and leaves bash as stored', async () => {
    const onSave = vi.fn(async () => {});
    render(<ToolAccessEditor value={allow('bash')} tools={TOOLS} onSave={onSave} autosave />);

    fireEvent.click(box(/^shell/i));
    await advance(500);

    expect(onSave).toHaveBeenCalledWith(allow('bash', 'shell'));
  });

  it('shows an entry naming a display name on its tool', () => {
    render(<ToolAccessEditor value={allow('Shell')} tools={TOOLS} onSave={vi.fn()} />);

    expect(box(/^shell/i).checked).toBe(true);
    expect(screen.getByTestId('other-names-shell')).toHaveTextContent('saved as Shell');
  });

  // The server reads ids and display names one way everywhere
  // (ruleNamesTool): exactly on the allow side, in any case on the deny side.
  it('shows a deny naming the display name in another case on its tool', () => {
    render(<ToolAccessEditor value={deny('SHELL')} tools={TOOLS} onSave={vi.fn()} />);

    expect(box(/^shell/i).checked).toBe(true);
    expect(screen.getByTestId('other-names-shell')).toHaveTextContent('saved as SHELL');
    expect(unmatchedGroup()).toBeNull();
  });

  it('lists an allow naming the display name in another case as matching no tool', () => {
    render(<ToolAccessEditor value={allow('SHELL')} tools={TOOLS} onSave={vi.fn()} />);

    expect(box(/^shell/i).checked).toBe(false);
    expect(within(unmatchedGroup()!).getByText('SHELL')).toBeInTheDocument();
  });

  it('shows a deny naming a tool id in another case on its tool', () => {
    const tools: ToolOption[] = [
      ...TOOLS,
      { id: 'note_tool', name: 'Note', categoryPath: 'notes', aliases: [] },
    ];
    render(<ToolAccessEditor value={deny('NOTE_TOOL')} tools={tools} onSave={vi.fn()} />);

    expect(box(/^note/i).checked).toBe(true);
    expect(screen.getByTestId('other-names-note_tool')).toHaveTextContent('saved as NOTE_TOOL');
    expect(unmatchedGroup()).toBeNull();
  });
});

describe('ToolAccessEditor — entries that match no tool', () => {
  it('lists removed and unknown ids in an allow list, leaving a valid entry on its tool', () => {
    render(
      <ToolAccessEditor
        value={allow('sandbox_run', 'database_*', 'search')}
        tools={TOOLS}
        onSave={vi.fn()}
      />
    );

    const group = unmatchedGroup()!;
    expect(within(group).getByText('sandbox_run')).toBeInTheDocument();
    expect(within(group).getByText('removed from Snaglet')).toBeInTheDocument();
    expect(within(group).getByText('database_*')).toBeInTheDocument();
    expect(within(group).getByText('no such tool')).toBeInTheDocument();
    expect(within(group).queryByText('search')).toBeNull();
    expect(box(/^search/i).checked).toBe(true);
  });

  it('removes them one at a time from an allow list; a valid entry is unaffected', async () => {
    const onSave = vi.fn(async () => {});
    render(
      <ToolAccessEditor
        value={allow('sandbox_run', 'search', 'database_*')}
        tools={TOOLS}
        onSave={onSave}
        autosave
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove sandbox_run' }));
    await advance(500);
    expect(onSave).toHaveBeenLastCalledWith(allow('search', 'database_*'));

    fireEvent.click(screen.getByRole('button', { name: 'Remove database_*' }));
    await advance(500);
    expect(onSave).toHaveBeenLastCalledWith(allow('search'));
    expect(unmatchedGroup()).toBeNull();
  });

  it('lists and removes them in a deny list too', async () => {
    const onSave = vi.fn(async () => {});
    render(
      <ToolAccessEditor
        value={deny('say', 'database_*', 'shell')}
        tools={TOOLS}
        onSave={onSave}
        autosave
      />
    );

    const group = unmatchedGroup()!;
    expect(within(group).getByText('say')).toBeInTheDocument();
    expect(within(group).getByText('database_*')).toBeInTheDocument();
    expect(box(/^shell/i).checked).toBe(true);

    fireEvent.click(within(group).getByRole('button', { name: 'Remove say' }));
    await advance(500);
    expect(onSave).toHaveBeenCalledWith(deny('database_*', 'shell'));
  });

  it('never rewrites them by itself: opening saves nothing, other edits keep them', async () => {
    const onSave = vi.fn(async () => {});
    render(
      <ToolAccessEditor
        value={allow('sandbox_run', 'database_*')}
        tools={TOOLS}
        onSave={onSave}
        autosave
      />
    );

    await advance(1000);
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(box(/^search/i));
    await advance(500);
    expect(onSave).toHaveBeenCalledWith(allow('sandbox_run', 'database_*', 'search'));
  });

  it('shows one row for copies of an entry, and removing it drops every copy', async () => {
    const onSave = vi.fn(async () => {});
    render(
      <ToolAccessEditor
        value={allow('sandbox_run', ' sandbox_run ', 'search')}
        tools={TOOLS}
        onSave={onSave}
        autosave
      />
    );

    expect(within(unmatchedGroup()!).getAllByText('sandbox_run')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Remove sandbox_run' }));
    await advance(500);
    expect(onSave).toHaveBeenCalledWith(allow('search'));
  });

  it('labels an MCP tool whose server is not connected', () => {
    render(
      <ToolAccessEditor value={allow('mcp__github__create_issue')} tools={TOOLS} onSave={vi.fn()} />
    );

    const group = unmatchedGroup()!;
    expect(within(group).getByText('mcp__github__create_issue')).toBeInTheDocument();
    expect(within(group).getByText('MCP tool not connected')).toBeInTheDocument();
  });

  it('the search filters them by their stored text', () => {
    render(
      <ToolAccessEditor value={allow('sandbox_run', 'database_*')} tools={TOOLS} onSave={vi.fn()} />
    );

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search tools' }), {
      target: { value: 'sandbox' },
    });

    const group = unmatchedGroup()!;
    expect(within(group).getByText('sandbox_run')).toBeInTheDocument();
    expect(within(group).queryByText('database_*')).toBeNull();
    expect(screen.queryByText('No tools match')).toBeNull();
  });

  it('lists nothing as unmatched before the tool list loads', () => {
    render(<ToolAccessEditor value={allow('sandbox_run', 'search')} tools={[]} onSave={vi.fn()} />);

    expect(unmatchedGroup()).toBeNull();
  });
});
