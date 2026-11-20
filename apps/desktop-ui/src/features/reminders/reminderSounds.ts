/**
 * Reminder sounds: the built-in WAVs in `public/sounds/reminders/<id>.wav`
 * (the desktop shell bundles the same files for native notifications).
 * `none` is silent. Playback is best effort: a webview without `Audio`, or
 * one that refuses to play, stays quiet rather than throwing.
 */
import type { ReminderSoundId } from '@snaglet/shared/types';

export const REMINDER_SOUND_LABELS: Record<ReminderSoundId, string> = {
  chime: 'Chime',
  bell: 'Bell',
  ping: 'Ping',
  pulse: 'Pulse',
  marimba: 'Marimba',
  none: 'None',
};

function reminderSoundUrl(sound: Exclude<ReminderSoundId, 'none'>): string {
  const base = import.meta.env.BASE_URL ?? '/';
  return `${base.endsWith('/') ? base : `${base}/`}sounds/reminders/${sound}.wav`;
}

/** One sound at a time: a new one (or a second ▶) restarts instead of overlapping. */
let current: HTMLAudioElement | null = null;

export function playReminderSound(sound: ReminderSoundId): void {
  if (sound === 'none' || typeof Audio === 'undefined') return;
  try {
    current?.pause();
    const audio = new Audio(reminderSoundUrl(sound));
    current = audio;
    const played = audio.play();
    if (played && typeof played.catch === 'function') {
      played.catch((err: unknown) => console.warn('[reminders] sound did not play', err));
    }
  } catch {
    // No audio output available.
  }
}
