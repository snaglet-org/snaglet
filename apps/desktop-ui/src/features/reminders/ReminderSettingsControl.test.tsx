import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeNotificationStatus, ReminderSettings } from '@snaglet/shared/types';
import { FetchError } from '@desktop/utils/api/core';

const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  deleteSettings: vi.fn(),
  upcoming: vi.fn(),
}));
vi.mock('@desktop/utils/api/reminders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@desktop/utils/api/reminders')>()),
  remindersApi: api,
}));

const native = vi.hoisted(() => ({
  status: vi.fn(),
  requestPermission: vi.fn(),
  sync: vi.fn(),
  cancelAll: vi.fn(),
  onClicked: vi.fn(),
}));
vi.mock('./nativeNotifications', () => ({ nativeNotifications: native }));

import { REMINDER_SAVE_DEBOUNCE_MS, ReminderSettingsControl } from './ReminderSettingsControl';

const EVENT = { kind: 'event' as const, eventId: 'event-1111111111111-aaaaaaaaa' };

const status = (over: Partial<NativeNotificationStatus> = {}): NativeNotificationStatus => ({
  platform: 'macos',
  supported: true,
  permission: 'granted',
  canSchedule: true,
  ...over,
});

function settings(over: Partial<ReminderSettings> = {}): ReminderSettings {
  return {
    item: EVENT,
    enabled: true,
    atStart: true,
    offsets: [{ amount: 15, unit: 'minutes' }],
    sound: 'chime',
    updatedAt: '2026-10-15T09:00:00.000Z',
    ...over,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
}

async function renderControl(loaded: ReminderSettings | null) {
  api.getSettings.mockResolvedValue({ settings: loaded });
  const view = render(<ReminderSettingsControl item={EVENT} />);
  await flush();
  return view;
}

const reminderButton = () =>
  screen.getByRole('button', { name: /^(Enable|Disable) notification$/ });

describe('ReminderSettingsControl', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    for (const fn of [...Object.values(api), ...Object.values(native)]) fn.mockReset();
    api.updateSettings.mockImplementation(async (_item, body) => ({
      settings: { ...settings(), ...body },
    }));
    native.status.mockResolvedValue(status());
    native.requestPermission.mockResolvedValue(status());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('loads an item with no settings as off, with only the Enable notification button', async () => {
    await renderControl(null);
    expect(api.getSettings).toHaveBeenCalledWith(EVENT);
    expect(reminderButton()).toHaveTextContent('Enable notification');
    expect(screen.queryByText('At start time')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add reminder' })).not.toBeInTheDocument();
  });

  it('is one button: Enable notification turns it on, then reads Disable notification', async () => {
    await renderControl(null);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enable notification' }));
    expect(screen.getByRole('button', { name: 'Disable notification' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disable notification' }));
    expect(screen.getByRole('button', { name: 'Enable notification' })).toBeInTheDocument();
  });

  it('turning it on saves the defaults once the debounce passes and asks for permission', async () => {
    native.status.mockResolvedValue(status({ permission: 'unknown' }));
    native.requestPermission.mockResolvedValue(status({ permission: 'granted' }));
    await renderControl(null);

    fireEvent.click(reminderButton());
    await flush();
    expect(screen.getByText('At start time')).toBeInTheDocument();
    expect(native.requestPermission).toHaveBeenCalledTimes(1);
    expect(api.updateSettings).not.toHaveBeenCalled();

    await advance(REMINDER_SAVE_DEBOUNCE_MS);
    expect(api.updateSettings).toHaveBeenCalledTimes(1);
    expect(api.updateSettings).toHaveBeenCalledWith(EVENT, {
      enabled: true,
      atStart: true,
      offsets: [],
      sound: 'chime',
    });
    expect(screen.queryByText(/Only in-app banners/)).not.toBeInTheDocument();
  });

  it('says only in-app banners will appear when native permission is denied', async () => {
    native.status.mockResolvedValue(status({ permission: 'unknown' }));
    native.requestPermission.mockResolvedValue(status({ permission: 'denied' }));
    await renderControl(null);
    fireEvent.click(reminderButton());
    await flush();
    expect(screen.getByText(/Only in-app banners will appear/)).toHaveTextContent(
      'System Settings → Notifications → Snaglet'
    );
  });

  it('shows no note where native notifications are unsupported', async () => {
    native.status.mockResolvedValue(status({ supported: false, permission: 'unknown' }));
    await renderControl(null);
    fireEvent.click(reminderButton());
    await flush();
    expect(native.requestPermission).not.toHaveBeenCalled();
    expect(screen.queryByText(/Only in-app banners/)).not.toBeInTheDocument();
  });

  it('adds, edits and removes "before" reminders, one save per burst', async () => {
    await renderControl(settings());
    expect(screen.getByLabelText('Reminder 1 amount')).toHaveValue(15);

    fireEvent.click(screen.getByRole('button', { name: 'Add reminder' }));
    // The next suggestion not already listed.
    expect(screen.getByLabelText('Reminder 2 amount')).toHaveValue(1);
    expect(screen.getByLabelText('Reminder 2 unit')).toHaveValue('hours');
    fireEvent.change(screen.getByLabelText('Reminder 1 amount'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Reminder 2 unit'), { target: { value: 'days' } });
    await advance(REMINDER_SAVE_DEBOUNCE_MS);
    expect(api.updateSettings).toHaveBeenCalledTimes(1);
    expect(api.updateSettings).toHaveBeenLastCalledWith(EVENT, {
      enabled: true,
      atStart: true,
      offsets: [
        { amount: 30, unit: 'minutes' },
        { amount: 1, unit: 'days' },
      ],
      sound: 'chime',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove reminder 1' }));
    fireEvent.click(screen.getByText('At start time'));
    await advance(REMINDER_SAVE_DEBOUNCE_MS);
    expect(api.updateSettings).toHaveBeenCalledTimes(2);
    expect(api.updateSettings).toHaveBeenLastCalledWith(EVENT, {
      enabled: true,
      atStart: false,
      offsets: [{ amount: 1, unit: 'days' }],
      sound: 'chime',
    });
  });

  it('drops a duplicate offset from the save', async () => {
    await renderControl(settings());
    fireEvent.click(screen.getByRole('button', { name: 'Add reminder' }));
    fireEvent.change(screen.getByLabelText('Reminder 2 amount'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('Reminder 2 unit'), { target: { value: 'minutes' } });
    await advance(REMINDER_SAVE_DEBOUNCE_MS);
    expect(api.updateSettings).toHaveBeenLastCalledWith(
      EVENT,
      expect.objectContaining({ offsets: [{ amount: 15, unit: 'minutes' }] })
    );
  });

  it('an invalid amount shows an error and saves nothing until fixed', async () => {
    await renderControl(settings());
    const amount = screen.getByLabelText('Reminder 1 amount');
    fireEvent.change(amount, { target: { value: '0' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Use a whole number from 1 to 999.');
    expect(amount).toHaveAttribute('aria-invalid', 'true');
    await advance(REMINDER_SAVE_DEBOUNCE_MS * 2);
    expect(api.updateSettings).not.toHaveBeenCalled();

    fireEvent.change(amount, { target: { value: '2.5' } });
    await advance(REMINDER_SAVE_DEBOUNCE_MS);
    expect(api.updateSettings).not.toHaveBeenCalled();

    fireEvent.change(amount, { target: { value: '2' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // One reminder: the unit reads singular only for 1.
    expect(screen.getByRole('option', { name: 'minutes' })).toBeInTheDocument();
    await advance(REMINDER_SAVE_DEBOUNCE_MS);
    expect(api.updateSettings).toHaveBeenCalledWith(
      EVENT,
      expect.objectContaining({ offsets: [{ amount: 2, unit: 'minutes' }] })
    );
  });

  it('previews the chosen sound; None has nothing to play', async () => {
    const played: string[] = [];
    class FakeAudio {
      constructor(public src: string) {}
      play() {
        played.push(this.src);
        return Promise.resolve();
      }
      pause() {}
    }
    vi.stubGlobal('Audio', FakeAudio);
    await renderControl(settings({ sound: 'marimba' }));

    fireEvent.click(screen.getByRole('button', { name: 'Play Marimba' }));
    expect(played).toEqual(['/sounds/reminders/marimba.wav']);

    fireEvent.change(screen.getByLabelText('Reminder sound'), { target: { value: 'none' } });
    expect(screen.getByRole('button', { name: 'Play None' })).toBeDisabled();
    await advance(REMINDER_SAVE_DEBOUNCE_MS);
    expect(api.updateSettings).toHaveBeenLastCalledWith(
      EVENT,
      expect.objectContaining({ sound: 'none' })
    );
  });

  it('sends a pending change at once when it unmounts (its popover closed)', async () => {
    const view = await renderControl(settings());
    fireEvent.click(reminderButton());
    expect(api.updateSettings).not.toHaveBeenCalled();
    view.unmount();
    expect(api.updateSettings).toHaveBeenCalledWith(
      EVENT,
      expect.objectContaining({ enabled: false })
    );
  });

  it('a failed save says so', async () => {
    api.updateSettings.mockRejectedValue(new Error('Server unavailable'));
    await renderControl(settings());
    fireEvent.click(screen.getByText('At start time'));
    await advance(REMINDER_SAVE_DEBOUNCE_MS);
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Couldn't save reminders: Server unavailable"
    );
  });

  it('a load error offers Retry', async () => {
    api.getSettings.mockRejectedValueOnce(new Error('offline'));
    render(<ReminderSettingsControl item={EVENT} />);
    await flush();
    expect(screen.getByText(/Couldn't load reminders: offline/)).toBeInTheDocument();
    expect(reminderButton()).toBeDisabled();
    api.getSettings.mockResolvedValue({ settings: settings() });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await flush();
    expect(reminderButton()).toHaveTextContent('Disable notification');
  });

  it('hides itself when the server has no reminders for the item (404)', async () => {
    api.getSettings.mockRejectedValue(new FetchError('Not found', 404));
    const { container } = render(<ReminderSettingsControl item={EVENT} />);
    await flush();
    expect(container).toBeEmptyDOMElement();
  });
});
