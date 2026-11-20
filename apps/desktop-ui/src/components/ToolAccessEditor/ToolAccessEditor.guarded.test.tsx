/**
 * ToolAccessEditor — Guarded indicator + Trusted-mode action.
 *
 * New agents are created server-side with per-tool
 * `requiresConfirmation: true` overrides for the guarded set (shell/file/
 * destructive tools). The agent-level editor surface must:
 *   - show a legible "guarded" indicator with the plain-language copy,
 *   - offer a single "Trusted mode" action behind an inline are-you-sure,
 *   - clear only the confirmation flags on confirm (settings survive),
 *   - stay inert for consumers that don't pass these props (such as the
 *     per-thread override surface).
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ToolAccessEditor, type ToolOption } from './ToolAccessEditor';
import { clearConfirmationOverrides, countConfirmingTools } from './guardedOverrides';
import type { ToolAccessConfig } from '@snaglet/shared/types';

const TOOLS: ToolOption[] = [
  { id: 'shell_exec', name: 'Shell Exec', categoryPath: 'system', description: 'Run a command' },
  { id: 'file_read', name: 'File Read', categoryPath: 'files', description: 'Read a file' },
];

const ALL_MODE: ToolAccessConfig = { mode: 'all', allowList: [], denyList: [] };

const GUARDED_OVERRIDES = {
  shell_exec: { requiresConfirmation: true },
  file_write: { requiresConfirmation: true, settings: { rootDir: '/proj' } },
};

const COPY = /shell, file, and destructive tools ask before running/i;

function renderEditor(props: Partial<Parameters<typeof ToolAccessEditor>[0]> = {}) {
  return render(<ToolAccessEditor value={ALL_MODE} tools={TOOLS} onSave={vi.fn()} {...props} />);
}

describe('Guarded indicator', () => {
  it('shows the guarded badge and copy when confirmation overrides exist', () => {
    renderEditor({ toolOverrides: GUARDED_OVERRIDES, onSaveToolOverrides: vi.fn() });

    expect(screen.getByText('guarded')).toBeInTheDocument();
    expect(screen.getByText(COPY)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Trusted mode' })).toBeInTheDocument();
  });

  it('renders nothing guarded for an agent with no confirmation overrides (existing agents)', () => {
    renderEditor({ toolOverrides: null, onSaveToolOverrides: vi.fn() });

    expect(screen.queryByText('guarded')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Trusted mode' })).toBeNull();
  });

  it('stays inert when the consumer does not pass the new props (thread surface)', () => {
    renderEditor();

    expect(screen.queryByText('guarded')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Trusted mode' })).toBeNull();
  });
});

describe('Trusted mode', () => {
  it('arms an inline are-you-sure and cancel backs out without saving', async () => {
    const user = userEvent.setup();
    const onSaveToolOverrides = vi.fn();
    renderEditor({ toolOverrides: GUARDED_OVERRIDES, onSaveToolOverrides });

    await user.click(screen.getByRole('button', { name: 'Trusted mode' }));
    expect(screen.getByText(/let this agent run them without asking\?/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onSaveToolOverrides).not.toHaveBeenCalled();
    expect(screen.queryByText(/without asking\?/i)).toBeNull();
    // still guarded
    expect(screen.getByText('guarded')).toBeInTheDocument();
  });

  it('confirm clears exactly the confirmation flags — settings survive, empty map becomes null', async () => {
    const user = userEvent.setup();
    const onSaveToolOverrides = vi.fn().mockResolvedValue(undefined);
    renderEditor({ toolOverrides: GUARDED_OVERRIDES, onSaveToolOverrides });

    await user.click(screen.getByRole('button', { name: 'Trusted mode' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(onSaveToolOverrides).toHaveBeenCalledTimes(1);
    expect(onSaveToolOverrides).toHaveBeenCalledWith({
      // shell_exec had only the flag → dropped entirely
      file_write: { settings: { rootDir: '/proj' } },
    });
  });

  it('surfaces a failed clear inline and keeps the guarded state', async () => {
    const user = userEvent.setup();
    const onSaveToolOverrides = vi.fn().mockRejectedValue(new Error('offline'));
    renderEditor({ toolOverrides: GUARDED_OVERRIDES, onSaveToolOverrides });

    await user.click(screen.getByRole('button', { name: 'Trusted mode' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText('offline')).toBeInTheDocument();
    expect(screen.getByText('guarded')).toBeInTheDocument();
  });
});

describe('guardedOverrides helpers', () => {
  it('countConfirmingTools counts only requiresConfirmation:true entries', () => {
    expect(countConfirmingTools(null)).toBe(0);
    expect(countConfirmingTools({})).toBe(0);
    expect(
      countConfirmingTools({
        a: { requiresConfirmation: true },
        b: { requiresConfirmation: false },
        c: { settings: { x: 1 } },
      })
    ).toBe(1);
  });

  it('clearConfirmationOverrides strips true flags, keeps settings and explicit false, nulls when empty', () => {
    expect(clearConfirmationOverrides(null)).toBeNull();
    expect(clearConfirmationOverrides({ a: { requiresConfirmation: true } })).toBeNull();
    expect(
      clearConfirmationOverrides({
        a: { requiresConfirmation: true, settings: { x: 1 } },
        b: { requiresConfirmation: false },
        c: { settings: { y: 2 } },
      })
    ).toEqual({
      a: { settings: { x: 1 } },
      b: { requiresConfirmation: false },
      c: { settings: { y: 2 } },
    });
  });
});
