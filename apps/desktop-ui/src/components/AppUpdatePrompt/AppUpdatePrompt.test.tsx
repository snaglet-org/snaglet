import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRecord } from '@snaglet/shared/types';

const shell = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: shell.invoke,
  Channel: class {
    constructor(public onmessage: (message: unknown) => void) {}
  },
}));
vi.mock('@desktop/utils/tauriEnv', () => ({ isTauriEnv: () => true }));
vi.mock('@desktop/utils/toast', () => ({ showToast: vi.fn() }));
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    notificationsApi: { ...actual.notificationsApi, markRead: vi.fn(async () => undefined) },
    appUpdateApi: {
      status: vi.fn(async () => ({
        currentVersion: '1.0.0',
        lastCheckedAt: null,
        latest: null,
        updateAvailable: true,
        lastError: null,
      })),
    },
  };
});

import { NotificationPopover } from '@desktop/components/StatusBar/consumers/NotificationPopover';
import { seedAgentWork } from '@desktop/utils/agentWorkState';
import { dismissAppUpdateOffer } from '@desktop/utils/appUpdate';
import { showToast } from '@desktop/utils/toast';
import { AppUpdatePrompt } from './AppUpdatePrompt';

const offer: NotificationRecord = {
  id: 'notification-1111111111111-aaaaaaaaa',
  type: 'app_update',
  title: 'Snaglet v1.0.1 is available',
  body: 'You are on 1.0.0. Click to update.',
  threadId: null,
  agentId: null,
  runId: null,
  read: false,
  dismissed: false,
  createdAt: new Date().toISOString(),
};

/** Install calls the shell made so far (the support check is not one). */
function installs(): unknown[] {
  return shell.invoke.mock.calls.filter(([command]) => command === 'install_app_update');
}

/** This copy can update itself unless `reason` is given. */
function shellSupports(reason?: string) {
  shell.invoke.mockImplementation(async (command: string) => {
    if (command === 'app_update_support' && reason) {
      throw { kind: 'unsupported', message: reason };
    }
    return command === 'install_app_update' ? '1.0.1' : undefined;
  });
}

async function renderWithPrompt() {
  render(
    <>
      <NotificationPopover notifications={[offer]} onClose={vi.fn()} />
      <AppUpdatePrompt />
    </>
  );
  fireEvent.click(screen.getByText(offer.title));
  return screen.findByRole('dialog', { name: 'Snaglet v1.0.1 is available' });
}

function thread(id: string) {
  return { id, kind: 'thread-run' as const, startedAt: '2026-11-20T10:00:00.000Z' };
}

beforeEach(() => shellSupports());

afterEach(() => {
  act(() => {
    dismissAppUpdateOffer();
    seedAgentWork([]);
  });
  shell.invoke.mockReset();
  vi.mocked(showToast).mockReset();
});

describe('AppUpdatePrompt', () => {
  it('opens on the notification click and installs nothing yet', async () => {
    const dialog = await renderWithPrompt();
    expect(dialog).toHaveTextContent('Install and restart?');
    expect(screen.getByRole('button', { name: 'Install' })).toBeEnabled();
    expect(installs()).toHaveLength(0);
  });

  it('closes on Later without installing anything', async () => {
    await renderWithPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(installs()).toHaveLength(0);
  });

  it('starts the install once on Install', async () => {
    await renderWithPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(installs()).toHaveLength(1));
  });

  it('says running work stops, counting working agents', async () => {
    act(() => seedAgentWork([thread('run-1'), thread('run-2')]));
    expect(await renderWithPrompt()).toHaveTextContent(
      'Anything still running stops, including 2 working agents.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));

    act(() => seedAgentWork([thread('run-1')]));
    fireEvent.click(screen.getByText(offer.title));
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'Anything still running stops, including 1 working agent.'
    );
  });

  it('still says running work stops when no agent is working', async () => {
    const dialog = await renderWithPrompt();
    expect(dialog).toHaveTextContent('Anything still running stops.');
    expect(dialog).not.toHaveTextContent(/working agent/);
  });

  it('does not ask where this copy cannot update; it gives the reason instead', async () => {
    shellSupports('Snaglet Preview doesn’t install updates.');
    render(
      <>
        <NotificationPopover notifications={[offer]} onClose={vi.fn()} />
        <AppUpdatePrompt />
      </>
    );
    fireEvent.click(screen.getByText(offer.title));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        'Snaglet Preview doesn’t install updates.',
        expect.objectContaining({ action: expect.objectContaining({ label: 'Release page' }) })
      )
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(installs()).toHaveLength(0);
  });
});
