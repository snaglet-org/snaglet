import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import type { ThreadNotificationSettings } from '@snaglet/shared/types';

const api = vi.hoisted(() => ({
  getNotificationSettings: vi.fn(),
  setNotificationSettings: vi.fn(),
}));
vi.mock('@desktop/utils/api', () => ({ threadsApi: api }));

const sounds = vi.hoisted(() => ({
  playReminderSound: vi.fn(),
  REMINDER_SOUND_LABELS: {
    chime: 'Chime',
    bell: 'Bell',
    ping: 'Ping',
    pulse: 'Pulse',
    marimba: 'Marimba',
    none: 'None',
  },
}));
vi.mock('@desktop/features/reminders/reminderSounds', () => sounds);

const native = vi.hoisted(() => ({
  nativeNotifications: {
    status: vi.fn(async () => ({
      platform: 'macos',
      supported: true,
      permission: 'granted',
      canSchedule: true,
    })),
    requestPermission: vi.fn(async () => ({
      platform: 'macos',
      supported: true,
      permission: 'granted',
      canSchedule: true,
    })),
  },
}));
vi.mock('@desktop/features/reminders/nativeNotifications', () => native);

import { NotificationsSection } from './NotificationsSection';

const THREAD = 'thread-1';

function settings(patch: Partial<ThreadNotificationSettings> = {}): ThreadNotificationSettings {
  return {
    threadId: THREAD,
    enabled: false,
    sound: 'chime',
    onCompleted: true,
    onFailed: true,
    updatedAt: null,
    ...patch,
  };
}

describe('NotificationsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getNotificationSettings.mockResolvedValue(settings());
    api.setNotificationSettings.mockImplementation(
      async (_id: string, input: Partial<ThreadNotificationSettings>) =>
        settings({ ...input, updatedAt: '2026-10-12T00:00:00.000Z' })
    );
    native.nativeNotifications.status.mockResolvedValue({
      platform: 'macos',
      supported: true,
      permission: 'granted',
      canSchedule: true,
    });
  });

  const box = () =>
    screen.findByRole('checkbox', {
      name: 'Send a notification for when any agent in this thread run ends',
    });

  it('is one compact row: a single checkbox and the sound, no extra explanation', async () => {
    render(<NotificationsSection threadId={THREAD} />);

    expect(await box()).not.toBeChecked();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText(/When a run finishes/)).toBeNull();
    expect(screen.queryByText(/A run you stop yourself/)).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Run notification sound' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Play Chime' })).toBeInTheDocument();
    expect(api.getNotificationSettings).toHaveBeenCalledWith(THREAD);
  });

  it('checking it turns on alerts for both finished and failed runs', async () => {
    api.getNotificationSettings.mockResolvedValue(
      settings({ onCompleted: false, onFailed: false })
    );
    render(<NotificationsSection threadId={THREAD} />);

    fireEvent.click(await box());

    await waitFor(() =>
      expect(api.setNotificationSettings).toHaveBeenCalledWith(THREAD, {
        enabled: true,
        sound: 'chime',
        onCompleted: true,
        onFailed: true,
      })
    );
    await waitFor(async () => expect(await box()).toBeChecked());
    expect(screen.getByRole('combobox', { name: 'Run notification sound' })).toBeEnabled();
  });

  it('unchecking it turns off both outcomes', async () => {
    api.getNotificationSettings.mockResolvedValue(settings({ enabled: true }));
    render(<NotificationsSection threadId={THREAD} />);

    const checkbox = await box();
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);

    await waitFor(() =>
      expect(api.setNotificationSettings).toHaveBeenCalledWith(THREAD, {
        enabled: false,
        sound: 'chime',
        onCompleted: false,
        onFailed: false,
      })
    );
  });

  it('shows a thread with only one outcome on as partly on, and checking it turns both on', async () => {
    api.getNotificationSettings.mockResolvedValue(settings({ enabled: true, onFailed: false }));
    render(<NotificationsSection threadId={THREAD} />);

    const checkbox = await box();
    expect(checkbox).not.toBeChecked();
    expect((checkbox as HTMLInputElement).indeterminate).toBe(true);
    fireEvent.click(checkbox);

    await waitFor(() =>
      expect(api.setNotificationSettings).toHaveBeenCalledWith(
        THREAD,
        expect.objectContaining({ enabled: true, onCompleted: true, onFailed: true })
      )
    );
  });

  it('asks for OS notification permission the first time it is turned on', async () => {
    native.nativeNotifications.status.mockResolvedValue({
      platform: 'macos',
      supported: true,
      permission: 'unknown',
      canSchedule: true,
    });
    render(<NotificationsSection threadId={THREAD} />);

    fireEvent.click(await box());

    await waitFor(() => expect(native.nativeNotifications.requestPermission).toHaveBeenCalled());
  });

  it('saves the picked sound', async () => {
    api.getNotificationSettings.mockResolvedValue(settings({ enabled: true }));
    render(<NotificationsSection threadId={THREAD} />);

    const select = await screen.findByRole('combobox', { name: 'Run notification sound' });
    fireEvent.change(select, { target: { value: 'marimba' } });

    await waitFor(() =>
      expect(api.setNotificationSettings).toHaveBeenCalledWith(
        THREAD,
        expect.objectContaining({ sound: 'marimba' })
      )
    );
  });

  it('previews the sound without saving', async () => {
    api.getNotificationSettings.mockResolvedValue(settings({ enabled: true, sound: 'bell' }));
    render(<NotificationsSection threadId={THREAD} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Play Bell' }));

    expect(sounds.playReminderSound).toHaveBeenCalledWith('bell');
    expect(api.setNotificationSettings).not.toHaveBeenCalled();
  });

  it('cannot preview silence', async () => {
    api.getNotificationSettings.mockResolvedValue(settings({ enabled: true, sound: 'none' }));
    render(<NotificationsSection threadId={THREAD} />);
    expect(await screen.findByRole('button', { name: 'Play None' })).toBeDisabled();
  });

  it('reports a load failure instead of a stuck loading hint', async () => {
    api.getNotificationSettings.mockRejectedValueOnce(new Error('settings unavailable'));
    render(<NotificationsSection threadId={THREAD} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('settings unavailable');
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('reports a save failure', async () => {
    api.setNotificationSettings.mockRejectedValueOnce(new Error('could not save'));
    render(<NotificationsSection threadId={THREAD} />);

    fireEvent.click(await box());

    expect(await screen.findByRole('alert')).toHaveTextContent('could not save');
  });

  it('hints that only the sound will play when OS notifications are denied', async () => {
    api.getNotificationSettings.mockResolvedValue(settings({ enabled: true }));
    native.nativeNotifications.status.mockResolvedValue({
      platform: 'macos',
      supported: true,
      permission: 'denied',
      canSchedule: true,
    });
    render(<NotificationsSection threadId={THREAD} />);

    expect(await screen.findByText(/System notifications are off for Snaglet/)).toBeInTheDocument();
  });

  it('shows no permission hint while the feature is off', async () => {
    native.nativeNotifications.status.mockResolvedValue({
      platform: 'macos',
      supported: true,
      permission: 'denied',
      canSchedule: true,
    });
    render(<NotificationsSection threadId={THREAD} />);

    await box();
    expect(screen.queryByText(/System notifications are off for Snaglet/)).toBeNull();
  });
});
