import type { ScheduleRecord, ScheduleRunRecord } from '@snaglet/shared/types';
import { fetchData, getApiUrl } from './core';
import { getPanelJsonHeaders } from '../panelToken';

export const schedulesApi = {
  list: () => fetchData<ScheduleRecord[]>(getApiUrl('/schedules')),
  setEnabled: (id: string, enabled: boolean) =>
    fetchData<ScheduleRecord>(getApiUrl(`/schedules/${id}/enabled`), {
      method: 'PATCH',
      headers: getPanelJsonHeaders(),
      body: JSON.stringify({ enabled }),
    }),
  runNow: (id: string) =>
    fetchData<ScheduleRunRecord>(getApiUrl(`/schedules/${id}/run`), {
      method: 'POST',
      headers: getPanelJsonHeaders(),
    }),
  runs: (id: string) => fetchData<ScheduleRunRecord[]>(getApiUrl(`/schedules/${id}/runs`)),
};
