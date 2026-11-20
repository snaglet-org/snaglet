/**
 * ToolAccessEditor — canonical ids only.
 *
 * Merged tools keep their old ids as aliases so stored rules keep resolving,
 * but a person only ever picks from and reads canonical ids. Uses the real
 * alias registry: a stored `exec_command` shows as shell (op run) with a
 * "was exec_command" hint, and the stored entry is never rewritten on save.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolAccessConfig } from '@snaglet/shared/types';
import { TOOL_ALIASES } from '@snaglet/shared/utils';
import { ToolAccessEditor, type ToolOption } from './ToolAccessEditor';

// The canonical catalog, as GET /api/tools returns it (no old-id rows).
const TOOLS: ToolOption[] = [
  { id: 'shell', name: 'Shell', categoryPath: 'shell' },
  { id: 'search', name: 'Search', categoryPath: 'search' },
  { id: 'node', name: 'Node', categoryPath: 'workspace' },
  { id: 'ask', name: 'Ask', categoryPath: 'workspace' },
  { id: 'git', name: 'Git', categoryPath: 'integrations' },
  { id: 'google_gmail', name: 'Gmail', categoryPath: 'integrations' },
  { id: 'mcp', name: 'MCP', categoryPath: 'system' },
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

const advance = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ToolAccessEditor — canonical ids only', () => {
  it('lists no old id anywhere in the picker, even when stored rules use them', () => {
    render(
      <ToolAccessEditor
        value={allow('exec_command', 'workspace_search', 'get_clarification', 'move_container')}
        tools={TOOLS}
        onSave={vi.fn()}
      />
    );

    const list = screen.getByRole('group', { name: 'Tools' });
    expect(within(list).getAllByRole('checkbox')).toHaveLength(TOOLS.length);
    // Old ids appear only inside the "was …" hints, never as a row of their own.
    for (const oldId of Object.keys(TOOL_ALIASES)) {
      expect(within(list).queryByText(oldId)).toBeNull();
    }
    expect(screen.getByTestId('old-ids-ask')).toHaveTextContent('was get_clarification');
  });

  it('shows a stored op alias as its canonical tool, scoped to its op, with a hint', () => {
    render(<ToolAccessEditor value={allow('exec_command')} tools={TOOLS} onSave={vi.fn()} />);

    expect(box(/^shell/i).checked).toBe(true);
    expect(screen.getByTestId('scoped-ops-shell')).toHaveTextContent('ops: run');
    expect(screen.getByTestId('old-ids-shell')).toHaveTextContent('was exec_command');
  });

  it('shows a param-pinned alias on its canonical tool, scoped to its pin', () => {
    render(<ToolAccessEditor value={allow('workspace_search')} tools={TOOLS} onSave={vi.fn()} />);

    expect(box(/^search/i).checked).toBe(true);
    expect(screen.getByTestId('scoped-ops-search')).toHaveTextContent('kind: workspace');
    expect(screen.getByTestId('old-ids-search')).toHaveTextContent('was workspace_search');
  });

  it('shows allow git_status as status only, not the whole git tool', () => {
    render(<ToolAccessEditor value={allow('git_status')} tools={TOOLS} onSave={vi.fn()} />);

    expect(box(/^git/i).checked).toBe(true);
    expect(screen.getByTestId('scoped-ops-git')).toHaveTextContent(/^subcommand: status$/);
    expect(screen.getByTestId('old-ids-git')).toHaveTextContent('was git_status');
    expect(screen.getByText(/only the uses shown are allowed/i)).toBeInTheDocument();
    expect(screen.queryByText(/any use allowed/i)).toBeNull();
  });

  it('a rule added to a scoped row replaces its bare old-id entry, as the hint says', async () => {
    const onSave = vi.fn(async () => {});
    render(<ToolAccessEditor value={allow('git_status')} tools={TOOLS} onSave={onSave} autosave />);

    fireEvent.change(screen.getByRole('textbox', { name: /add command rule for git/i }), {
      target: { value: 'git log:*' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await advance(500);

    expect(onSave).toHaveBeenCalledWith(allow('git(git log:*)'));
  });

  it('unions several pinned allows on one row', () => {
    render(
      <ToolAccessEditor
        value={allow('google_gmail_send', 'google_gmail_search')}
        tools={TOOLS}
        onSave={vi.fn()}
      />
    );

    expect(screen.getByTestId('scoped-ops-google_gmail')).toHaveTextContent(
      'operation: send, search'
    );
  });

  it('a pin-less alias reads as the whole tool', () => {
    render(<ToolAccessEditor value={allow('mcp_server')} tools={TOOLS} onSave={vi.fn()} />);

    expect(box(/^mcp/i).checked).toBe(true);
    expect(screen.queryByTestId('scoped-ops-mcp')).toBeNull();
    expect(screen.getByTestId('old-ids-mcp')).toHaveTextContent('was mcp_server');
  });

  it('shows deny git_push as blocking the whole git tool, as it does', () => {
    render(<ToolAccessEditor value={deny('git_push')} tools={TOOLS} onSave={vi.fn()} />);

    expect(box(/^git/i).checked).toBe(true);
    expect(screen.queryByTestId('scoped-ops-git')).toBeNull();
    expect(screen.getByTestId('old-ids-git')).toHaveTextContent('was git_push');
    expect(screen.getByText(/blocked entirely/i)).toBeInTheDocument();
  });

  it('shows a deny naming an op alias as its op only: other pins never narrow a deny', () => {
    render(
      <ToolAccessEditor
        value={deny('move_container', 'exec_command')}
        tools={TOOLS}
        onSave={vi.fn()}
      />
    );

    expect(screen.getByTestId('scoped-ops-node')).toHaveTextContent(/^ops: move$/);
    expect(screen.getByTestId('scoped-ops-shell')).toHaveTextContent(/^ops: run$/);
    expect(screen.getByText(/only the ops shown are blocked/i)).toBeInTheDocument();
  });

  it('labels a kind-scoped alias with its node kind', () => {
    render(<ToolAccessEditor value={allow('move_container')} tools={TOOLS} onSave={vi.fn()} />);

    expect(box(/^node/i).checked).toBe(true);
    expect(screen.getByTestId('scoped-ops-node')).toHaveTextContent('ops: move (container only)');
  });

  it('shows a rule stored under an old id as a chip on the canonical tool', () => {
    render(
      <ToolAccessEditor value={allow('exec_command(git:*)')} tools={TOOLS} onSave={vi.fn()} />
    );

    expect(box(/^shell/i).checked).toBe(true);
    const chip = screen.getByText('git:*').closest('span[title]');
    expect(chip).toHaveAttribute('title', 'Saved as exec_command(git:*)');
    expect(screen.queryByText(/any use allowed/i)).toBeNull();
  });

  it('never rewrites stored old ids on save', async () => {
    const onSave = vi.fn(async () => {});
    render(
      <ToolAccessEditor
        value={allow('exec_command', 'get_clarification')}
        tools={TOOLS}
        onSave={onSave}
        autosave
      />
    );

    fireEvent.click(box(/^search/i));
    await advance(500);

    expect(onSave).toHaveBeenCalledWith(allow('exec_command', 'get_clarification', 'search'));
  });

  it('removes a chip stored under an old id', async () => {
    const onSave = vi.fn(async () => {});
    render(
      <ToolAccessEditor
        value={allow('exec_command(git:*)', 'shell(ls:*)')}
        tools={TOOLS}
        onSave={onSave}
        autosave
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove rule git:*' }));
    await advance(500);

    expect(onSave).toHaveBeenCalledWith(allow('shell(ls:*)'));
  });

  it('a new rule supersedes a bare entry stored under an old id', async () => {
    const onSave = vi.fn(async () => {});
    render(
      <ToolAccessEditor value={allow('exec_command')} tools={TOOLS} onSave={onSave} autosave />
    );

    fireEvent.change(screen.getByRole('textbox', { name: /add command rule for shell/i }), {
      target: { value: 'git:*' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await advance(500);

    expect(onSave).toHaveBeenCalledWith(allow('shell(git:*)'));
  });

  it('unchecking the canonical tool clears entries stored under its old ids', async () => {
    const onSave = vi.fn(async () => {});
    render(
      <ToolAccessEditor
        value={allow('workspace_search', 'code_search', 'get_clarification')}
        tools={TOOLS}
        onSave={onSave}
        autosave
      />
    );

    fireEvent.click(box(/^search/i));
    await advance(500);

    expect(onSave).toHaveBeenCalledWith(allow('get_clarification'));
  });

  it('a listed id keeps its own meaning, as on the server', () => {
    const tools: ToolOption[] = [...TOOLS, { id: 'exec_command', name: 'Exec', categoryPath: 'x' }];
    render(<ToolAccessEditor value={allow('exec_command')} tools={tools} onSave={vi.fn()} />);

    expect(box(/^exec/i).checked).toBe(true);
    expect(box(/^shell/i).checked).toBe(false);
  });
});
