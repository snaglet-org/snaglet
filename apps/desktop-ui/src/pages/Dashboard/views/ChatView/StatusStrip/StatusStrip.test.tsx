import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StatusStrip } from './StatusStrip';

describe('StatusStrip', () => {
  it('keeps the md / txt toggle immediately before the far-right Settings leaf', async () => {
    const user = userEvent.setup();
    const onToggleSettings = vi.fn();
    const onRenderModeChange = vi.fn();
    render(
      <StatusStrip
        renderMode="md"
        onRenderModeChange={onRenderModeChange}
        settingsOpen={false}
        onToggleSettings={onToggleSettings}
      />
    );

    const view = screen.getByRole('button', { name: /md\s*\/\s*txt/ });
    expect(view).toHaveAttribute('aria-pressed', 'false');
    const settings = screen.getByRole('button', { name: 'Open chat and agent settings' });
    expect(view.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(settings).toHaveTextContent('Settings');
    expect(screen.queryByRole('button', { name: /clear/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /add agent/i })).toBeNull();

    await user.click(settings);
    expect(onToggleSettings).toHaveBeenCalledTimes(1);

    await user.click(view);
    expect(onRenderModeChange).toHaveBeenCalledWith('raw');
  });

  it('shows txt as pressed in raw mode and toggles back to md', async () => {
    const user = userEvent.setup();
    const onRenderModeChange = vi.fn();
    render(
      <StatusStrip
        renderMode="raw"
        onRenderModeChange={onRenderModeChange}
        settingsOpen={false}
        onToggleSettings={vi.fn()}
      />
    );

    const toggle = screen.getByRole('button', { name: /md\s*\/\s*txt/ });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle).toHaveAttribute('title', 'Render markdown');
    await user.click(toggle);
    expect(onRenderModeChange).toHaveBeenCalledWith('md');
  });

  it('announces the explicit close action while the settings panel is open', () => {
    render(
      <StatusStrip
        renderMode="raw"
        onRenderModeChange={vi.fn()}
        settingsOpen
        onToggleSettings={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Close settings' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });
});
