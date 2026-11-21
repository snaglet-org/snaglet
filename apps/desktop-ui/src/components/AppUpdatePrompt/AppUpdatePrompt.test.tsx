import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

function renderWithPrompt() {
  render(
    <>
      <NotificationPopover notifications={[offer]} onClose={vi.fn()} />
      <AppUpdatePrompt />
    </>
  );
  fireEvent.click(screen.getByText(offer.title));
  return screen.getByRole('dialog', { name: 'Snaglet v1.0.1 is available' });
}

function thread(id: string) {
  return { id, kind: 'thread-run' as const, startedAt: '2026-11-20T10:00:00.000Z' };
}

afterEach(() => {
  act(() => {
    dismissAppUpdateOffer();
    seedAgentWork([]);
  });
  shell.invoke.mockReset();
});

describe('AppUpdatePrompt', () => {
  it('opens on the notification click and invokes nothing yet', () => {
    const dialog = renderWithPrompt();
    expect(dialog).toHaveTextContent('Install and restart?');
    expect(screen.getByRole('button', { name: 'Install' })).toBeEnabled();
    expect(shell.invoke).not.toHaveBeenCalled();
  });

  it('closes on Later without invoking anything', () => {
    renderWithPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(shell.invoke).not.toHaveBeenCalled();
  });

  it('starts the install once on Install', async () => {
    shell.invoke.mockResolvedValue('1.0.1');
    renderWithPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(shell.invoke).toHaveBeenCalledTimes(1));
    expect(shell.invoke).toHaveBeenCalledWith('install_app_update', expect.anything());
  });

  it('says how many agents are working and that they will be stopped', () => {
    act(() => seedAgentWork([thread('run-1'), thread('run-2')]));
    expect(renderWithPrompt()).toHaveTextContent('2 agents are working. They will be stopped.');
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));

    act(() => seedAgentWork([thread('run-1')]));
    fireEvent.click(screen.getByText(offer.title));
    expect(screen.getByRole('dialog')).toHaveTextContent('1 agent is working. It will be stopped.');
  });

  it('leaves the agents line out when none are working', () => {
    expect(renderWithPrompt()).not.toHaveTextContent(/agents? (is|are) working/);
  });
});
