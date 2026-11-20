/**
 * Keeps the OS's scheduled notifications in step with the server: on start,
 * on `reminders:changed` (and a Notify section saving here), and every 30
 * minutes, it reads GET /api/reminders/upcoming?hours=72 and hands the list
 * to the native shell, which replaces everything Snaglet had scheduled. Bursts
 * collapse into one sync. Where native notifications are unsupported (the
 * browser, Windows, Linux, a shell without the commands) it does nothing.
 */
import { useEffect } from 'react';
import type { WsMessage } from '@snaglet/shared/types';
import { remindersApi } from '@desktop/utils/api/reminders';
import { nativeGranted, nativeNotifications } from './nativeNotifications';
import { isRemindersChangedFrame } from './reminderText';
import { onLocalRemindersChanged } from './remindersEvents';

export const REMINDER_SYNC_HOURS = 72;
export const REMINDER_SYNC_INTERVAL_MS = 30 * 60_000;
export const REMINDER_SYNC_DEBOUNCE_MS = 1000;

type AddMessageListener = (listener: (msg: WsMessage) => void) => () => void;

export function useNativeReminderSync(addMessageListener: AddMessageListener | undefined): void {
  useEffect(() => {
    let live = true;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;
    const stops: Array<() => void> = [];
    let running = false;
    let again = false;

    const run = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        // Permission can change in System Settings at any time: ask each run.
        const status = await nativeNotifications.status();
        if (!live || !nativeGranted(status)) return;
        const { reminders } = await remindersApi.upcoming(REMINDER_SYNC_HOURS);
        if (live) await nativeNotifications.sync(reminders);
      } catch {
        // Server unreachable: the next trigger or tick tries again.
      } finally {
        running = false;
        if (again && live) {
          again = false;
          void run();
        }
      }
    };

    const trigger = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        void run();
      }, REMINDER_SYNC_DEBOUNCE_MS);
    };

    void nativeNotifications.status().then((status) => {
      if (!live || !status.supported) return;
      void run();
      interval = setInterval(() => void run(), REMINDER_SYNC_INTERVAL_MS);
      stops.push(onLocalRemindersChanged(trigger));
      if (addMessageListener) {
        stops.push(
          addMessageListener((msg) => {
            if (isRemindersChangedFrame(msg.type)) trigger();
          })
        );
      }
    });

    return () => {
      live = false;
      if (debounce) clearTimeout(debounce);
      if (interval) clearInterval(interval);
      for (const stop of stops) stop();
    };
  }, [addMessageListener]);
}
