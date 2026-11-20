import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliInstallStatus } from './CliSettingsView';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@desktop/components', async () => {
  const controls = await vi.importActual<typeof import('@desktop/components/controls')>(
    '@desktop/components/controls'
  );
  return { Button: controls.Button };
});

import { CliSettingsView } from './CliSettingsView';

const notInstalled: CliInstallStatus = {
  available: true,
  installed: false,
  current: false,
  conflict: false,
  launcherPath: '/Users/test/.local/bin/snaglet',
  cliPath: '/Applications/Snaglet.app/Contents/Resources/cli/bin/snaglet.mjs',
  pathConfigured: true,
  pathExportCommand: 'export PATH="$HOME/.local/bin:$PATH"',
};

// Simulates the Tauri bridge marker checked by `isTauriEnv()`
// (`@desktop/utils/tauriEnv`), mirroring resolveDroppedFilePath.test.ts.
function enterTauriEnv() {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
}

function leaveTauriEnv() {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
}

describe('CliSettingsView', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  afterEach(() => {
    leaveTauriEnv();
  });

  describe('inside a Tauri shell', () => {
    beforeEach(() => {
      enterTauriEnv();
    });

    it('shows packaged availability and installs the command', async () => {
      invokeMock
        .mockResolvedValueOnce(notInstalled)
        .mockResolvedValueOnce({ ...notInstalled, installed: true, current: true });

      render(<CliSettingsView />);

      expect(await screen.findByText('Not installed')).toBeInTheDocument();
      await userEvent.setup().click(screen.getByRole('button', { name: 'Install CLI' }));

      expect(invokeMock).toHaveBeenNthCalledWith(1, 'cli_install_status');
      expect(invokeMock).toHaveBeenNthCalledWith(2, 'install_cli');
      expect(await screen.findByText('Installed')).toBeInTheDocument();
      expect(screen.getByText('/Users/test/.local/bin/snaglet')).toBeInTheDocument();
    });

    it('refuses to offer installation over an unmanaged snaglet command', async () => {
      invokeMock.mockResolvedValue({ ...notInstalled, installed: true, conflict: true });

      render(<CliSettingsView />);

      expect(await screen.findByText('Existing command found')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Update CLI' })).toBeDisabled();
      expect(screen.getByText(/will not overwrite the existing executable/)).toBeInTheDocument();
    });

    it('says so when the PATH command cannot be copied', async () => {
      invokeMock.mockResolvedValue({
        ...notInstalled,
        installed: true,
        current: true,
        pathConfigured: false,
      });
      const user = userEvent.setup();
      vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('clipboard denied'));

      render(<CliSettingsView />);
      await user.click(await screen.findByRole('button', { name: 'Copy' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('clipboard denied');
      expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    });

    it('surfaces invoke failures in the error banner', async () => {
      invokeMock.mockRejectedValue(new Error('cli_install_status blew up'));

      render(<CliSettingsView />);

      expect(await screen.findByRole('alert')).toHaveTextContent('cli_install_status blew up');
      expect(invokeMock).toHaveBeenCalledWith('cli_install_status');
    });
  });

  describe('outside a Tauri shell (plain-browser dev shell)', () => {
    it('never invokes and renders the graceful dev-shell state', async () => {
      render(<CliSettingsView />);

      expect(await screen.findByText('Not installed')).toBeInTheDocument();
      expect(
        screen.getByText(/This development shell does not\s+contain the staged runtime/)
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Install CLI' })).toBeDisabled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(invokeMock).not.toHaveBeenCalled();
    });
  });
});
