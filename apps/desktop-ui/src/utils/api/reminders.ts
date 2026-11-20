/**
 * Reminders API client — per-item reminder settings and the upcoming list the
 * desktop shell pre-schedules as native notifications. All routes are under
 * `/api/reminders` and enveloped; types live in `@snaglet/shared/types/reminders`.
 */
import type {
  ReminderItemRef,
  ReminderSettings,
  ReminderSettingsResponse,
  UpcomingRemindersResponse,
  UpdateReminderSettingsRequest,
} from '@snaglet/shared/types';
import { fetchData, getApiUrl } from './core';

/** The query string naming one item: `kind=event&eventId=…` and so on. */
export function reminderItemQuery(item: ReminderItemRef): string {
  const params = new URLSearchParams();
  params.set('kind', item.kind);
  switch (item.kind) {
    case 'event':
      params.set('eventId', item.eventId);
      break;
    case 'table_entry':
      params.set('tableId', item.tableId);
      params.set('entryId', item.entryId);
      params.set('fieldId', item.fieldId);
      break;
    case 'automation':
      params.set('automationId', item.automationId);
      break;
  }
  return params.toString();
}

const settingsUrl = (item: ReminderItemRef) =>
  getApiUrl(`/reminders/settings?${reminderItemQuery(item)}`);

export const remindersApi = {
  getSettings: (item: ReminderItemRef) => fetchData<ReminderSettingsResponse>(settingsUrl(item)),
  updateSettings: (item: ReminderItemRef, input: UpdateReminderSettingsRequest) =>
    fetchData<{ settings: ReminderSettings }>(settingsUrl(item), {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteSettings: (item: ReminderItemRef) =>
    fetchData<unknown>(settingsUrl(item), { method: 'DELETE' }),
  upcoming: (hours = 72) =>
    fetchData<UpcomingRemindersResponse>(
      getApiUrl(`/reminders/upcoming?hours=${encodeURIComponent(String(hours))}`)
    ),
};
