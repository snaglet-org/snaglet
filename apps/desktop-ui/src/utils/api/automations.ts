import type {
  AutomationPauseResponse,
  AutomationRecentRunsResponse,
  AutomationResponse,
  AutomationResumeResponse,
  AutomationRunNowResponse,
  AutomationRunsResponse,
  AutomationStatus,
  AutomationsResponse,
  CreateAutomationRequest,
  UndoAutomationPauseRequest,
  UndoAutomationResumeRequest,
  UpdateAutomationRequest,
} from '@snaglet/shared/types';
import { fetchData, getApiUrl } from './core';
import { getPanelJsonHeaders } from '../panelToken';

/** /api/automations. Writes carry the panel token: they are people's routes. */
export const automationsApi = {
  list: (status: AutomationStatus | 'all' = 'all') =>
    fetchData<AutomationsResponse>(getApiUrl(`/automations?status=${status}`)),
  get: (id: string) =>
    fetchData<AutomationResponse>(getApiUrl(`/automations/${encodeURIComponent(id)}`)),
  /** Its run log, newest first; `before` is the previous page's `nextCursor`. */
  runs: (id: string, page: { limit?: number; before?: string | null } = {}) => {
    const query = new URLSearchParams();
    if (page.limit) query.set('limit', String(page.limit));
    if (page.before) query.set('before', page.before);
    const qs = query.toString();
    return fetchData<AutomationRunsResponse>(
      getApiUrl(`/automations/${encodeURIComponent(id)}/runs${qs ? `?${qs}` : ''}`)
    );
  },
  /** The newest runs across every automation that is not deleted, newest first. */
  recentRuns: (limit = 20) =>
    fetchData<AutomationRecentRunsResponse>(getApiUrl(`/automations/runs/recent?limit=${limit}`)),
  create: (body: CreateAutomationRequest) =>
    fetchData<AutomationResponse>(getApiUrl('/automations'), {
      method: 'POST',
      headers: getPanelJsonHeaders(),
      body: JSON.stringify(body),
    }),
  update: (id: string, body: UpdateAutomationRequest) =>
    fetchData<AutomationResponse>(getApiUrl(`/automations/${encodeURIComponent(id)}`), {
      method: 'PATCH',
      headers: getPanelJsonHeaders(),
      body: JSON.stringify(body),
    }),
  /** `undoToken` is set when it paused an active one: {@link automationsApi.undoPause} resumes it. */
  pause: (id: string) =>
    fetchData<AutomationPauseResponse>(getApiUrl(`/automations/${encodeURIComponent(id)}/pause`), {
      method: 'POST',
      headers: getPanelJsonHeaders(),
    }),
  /** Active again with the failure streak the pause kept; 409 once it changed or expired, or at the active limit. */
  undoPause: (id: string, token: string) =>
    fetchData<AutomationResponse>(getApiUrl(`/automations/${encodeURIComponent(id)}/pause/undo`), {
      method: 'POST',
      headers: getPanelJsonHeaders(),
      body: JSON.stringify({ token } satisfies UndoAutomationPauseRequest),
    }),
  /** `undoToken` is set when it cleared a pause: {@link automationsApi.undoResume} puts it back. */
  resume: (id: string) =>
    fetchData<AutomationResumeResponse>(
      getApiUrl(`/automations/${encodeURIComponent(id)}/resume`),
      { method: 'POST', headers: getPanelJsonHeaders() }
    ),
  /** Paused again with the reason and failure streak the resume cleared; 409 once it changed or expired. */
  undoResume: (id: string, token: string) =>
    fetchData<AutomationResponse>(getApiUrl(`/automations/${encodeURIComponent(id)}/resume/undo`), {
      method: 'POST',
      headers: getPanelJsonHeaders(),
      body: JSON.stringify({ token } satisfies UndoAutomationResumeRequest),
    }),
  runNow: (id: string) =>
    fetchData<AutomationRunNowResponse>(getApiUrl(`/automations/${encodeURIComponent(id)}/run`), {
      method: 'POST',
      headers: getPanelJsonHeaders(),
    }),
  /** Cancels it (kept for history, listed in the Archive drawer); undo is resume. */
  remove: (id: string) =>
    fetchData<AutomationResponse>(getApiUrl(`/automations/${encodeURIComponent(id)}`), {
      method: 'DELETE',
      headers: getPanelJsonHeaders(),
    }),
  /** A deleted one back as it was (the Archive drawer's Restore); any other comes back unchanged. */
  restore: (id: string) =>
    fetchData<AutomationResponse>(getApiUrl(`/automations/${encodeURIComponent(id)}/restore`), {
      method: 'POST',
      headers: getPanelJsonHeaders(),
    }),
  /** A deleted one for good, run log too (the Archive drawer's Delete); 409 for any other. */
  purge: (id: string) =>
    fetchData<AutomationResponse>(getApiUrl(`/automations/${encodeURIComponent(id)}/purge`), {
      method: 'DELETE',
      headers: getPanelJsonHeaders(),
    }),
};
