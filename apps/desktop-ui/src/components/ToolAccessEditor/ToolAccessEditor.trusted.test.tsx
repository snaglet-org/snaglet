/**
 * ToolAccessEditor — flag-based Trusted / Guarded mode.
 *
 * With `onSaveTrustedToolCalls` the editor stores trust as the agent's
 * persisted `trustedToolCalls` flag (suppresses confirmation for permitted
 * native and MCP calls) instead of rewriting per-tool overrides, so switching
 * back to Guarded mode leaves those overrides as they were. Consumers
 * without that callback clear the confirmation overrides instead.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ToolAccessEditor, type ToolOption } from './ToolAccessEditor';
import type { ToolAccessConfig } from '@snaglet/shared/types';

const TOOLS: ToolOption[] = [
  { id: 'shell_exec', name: 'Shell Exec', categoryPath: 'system', description: 'Run a command' },
];
const ALL_MODE: ToolAccessConfig = { mode: 'all', allowList: [], denyList: [] };
const GUARDED_OVERRIDES = { shell_exec: { requiresConfirmation: true } };

function renderEditor(props: Partial<Parameters<typeof ToolAccessEditor>[0]> = {}) {
  return render(<ToolAccessEditor value={ALL_MODE} tools={TOOLS} onSave={vi.fn()} {...props} />);
}

describe('Trusted mode (persisted flag)', () => {
  it('confirming saves the trust flag and leaves per-tool overrides untouched', async () => {
    const user = userEvent.setup();
    const onSaveTrustedToolCalls = vi.fn().mockResolvedValue(undefined);
    const onSaveToolOverrides = vi.fn().mockResolvedValue(undefined);
    renderEditor({
      toolOverrides: GUARDED_OVERRIDES,
      onSaveToolOverrides,
      trustedToolCalls: false,
      onSaveTrustedToolCalls,
    });

    expect(screen.getByText('guarded')).toBeInTheDocument();
    expect(screen.getByText(/MCP servers that require confirmation ask/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Trusted mode' }));
    expect(
      screen.getByText(/permitted native and MCP tools without asking\?/i)
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(onSaveTrustedToolCalls).toHaveBeenCalledWith(true);
    expect(onSaveToolOverrides).not.toHaveBeenCalled();
  });

  it('offers Trusted mode even when no per-tool confirmation overrides exist (MCP prompts)', () => {
    renderEditor({
      toolOverrides: null,
      onSaveToolOverrides: vi.fn(),
      trustedToolCalls: false,
      onSaveTrustedToolCalls: vi.fn(),
    });

    expect(screen.getByRole('button', { name: 'Trusted mode' })).toBeInTheDocument();
  });

  it('a trusted agent shows the trusted badge and Guarded mode reverts the flag deterministically', async () => {
    const user = userEvent.setup();
    const onSaveTrustedToolCalls = vi.fn().mockResolvedValue(undefined);
    renderEditor({
      toolOverrides: GUARDED_OVERRIDES,
      onSaveToolOverrides: vi.fn(),
      trustedToolCalls: true,
      onSaveTrustedToolCalls,
    });

    expect(screen.getByText('trusted')).toBeInTheDocument();
    expect(screen.getByText(/native and MCP tools without asking/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Trusted mode' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Guarded mode' }));

    expect(onSaveTrustedToolCalls).toHaveBeenCalledWith(false);
  });

  it('surfaces a failed trust save inline and stays guarded', async () => {
    const user = userEvent.setup();
    const onSaveTrustedToolCalls = vi.fn().mockRejectedValue(new Error('offline'));
    renderEditor({
      toolOverrides: GUARDED_OVERRIDES,
      onSaveToolOverrides: vi.fn(),
      trustedToolCalls: false,
      onSaveTrustedToolCalls,
    });

    await user.click(screen.getByRole('button', { name: 'Trusted mode' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText('offline')).toBeInTheDocument();
    expect(screen.getByText('guarded')).toBeInTheDocument();
  });

  it('legacy consumers without the flag callback keep the override-clearing behavior', async () => {
    const user = userEvent.setup();
    const onSaveToolOverrides = vi.fn().mockResolvedValue(undefined);
    renderEditor({ toolOverrides: GUARDED_OVERRIDES, onSaveToolOverrides });

    await user.click(screen.getByRole('button', { name: 'Trusted mode' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(onSaveToolOverrides).toHaveBeenCalledWith(null);
  });
});
