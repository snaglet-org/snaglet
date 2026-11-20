/**
 * hooksWorkspacesApi — client for the GUI hook builder's folder-write REST
 * surface (`apps/server/src/routes/hooks.ts`). Mirrors
 * `toolWorkspacesApi` (./tools.ts) in shape and naming, minus the
 * install/deploy state tools have.
 * `HookRegistryService`'s FolderScanner remains the live build/registration authority;
 * a save through this client becomes live once the watcher's next pass picks
 * it up, not synchronously with the response — see HookBuilderPanel's save
 * copy for how that's surfaced honestly to the user.
 */
import { fetchData, getApiUrl } from './core';
import { getPanelJsonHeaders } from '../panelToken';
import type { HookRunRecord, UnattendedPolicy } from '@snaglet/shared/types';

export interface HookWorkspaceInfo {
  hookName: string;
  dir: string;
  /** `dir` relative to the user's home with a `~` prefix (e.g.
   *  `~/.snaglet/hooks/<name>`) — for UI copy naming where the code lives. */
  homeRelativeDir: string;
  files: string[];
  hasBuild: boolean;
}

interface HookWorkspaceFiles {
  'hook.ts': string;
}

/** Durable registration row (`hook_registrations`) as the server returns it. */
export interface HookRegistrationInfo {
  id: string;
  name: string;
  sourcePath: string;
  enabled: boolean;
  /** Agent the hook runs as; null = the event's agent, else the system actor. */
  runAsAgentId: string | null;
  /** The build run as was set for; new code clears run as. */
  runAsBuildHash: string | null;
  buildStatus: 'pending' | 'building' | 'ready' | 'failed' | 'missing';
  lastError: string | null;
  builtPath: string | null;
  lastBuiltAt: string | null;
  /** What a run this hook wakes does with a tool call that would ask. */
  unattendedPolicy: UnattendedPolicy;
  createdAt: string;
  updatedAt: string;
}

/** A registry row: the registration plus what its saved code declares. */
interface HookRegistryEntry extends HookRegistrationInfo {
  /** Events and schedules from describe; null while the hook is not registered. */
  declared: { events: string[]; schedules: unknown[] } | null;
}

/** What the saved hook.ts declares (describe output; null when unregistered). */
export interface HookDeclaredMeta {
  events: string[];
  filter: Record<string, unknown> | null;
  schedules: unknown[];
}

export interface HookCheckResult {
  registration: HookRegistrationInfo | null;
  declared: HookDeclaredMeta | null;
}

export interface HookRunHistoryDeleteResult {
  hookName: string;
  deletedRuns: number;
}

export interface HookDeleteResult extends HookRunHistoryDeleteResult {
  deletedRegistration: boolean;
  deletedSchedules: number;
  /** Where the hook's physical files went. `system-trash` = macOS Trash
   *  (recoverable via Finder "Put Back"); `snaglet-trash` = the
   *  `<SNAGLET_HOME>/trash` fallback folder named by `fallbackDir`; `none` =
   *  nothing was left on disk to move. */
  trash: {
    disposition: 'system-trash' | 'snaglet-trash' | 'none';
    fallbackDir: string | null;
  };
}

/** Body of POST /api/hooks/:hookName/run — see resolveHookInvocation.ts. */
export interface HookRunInput {
  nodeIds?: string[];
  /** table_entry:* events: the table and entry to resolve into the payload. */
  tableId?: string;
  entryId?: string;
  eventName?: string;
  event?: Record<string, unknown>;
}

interface HookTestRunResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface HookTestRun {
  nodeId: string | null;
  eventName: string;
  event: Record<string, unknown>;
  result: HookTestRunResult;
}

export const hooksWorkspacesApi = {
  list: () => fetchData<HookWorkspaceInfo[]>(getApiUrl('/hooks')),

  get: (hookName: string) => fetchData<HookWorkspaceInfo>(getApiUrl(`/hooks/${hookName}`)),

  save: (hookName: string, files: HookWorkspaceFiles) =>
    fetchData<{ workspace: HookWorkspaceInfo }>(getApiUrl('/hooks'), {
      method: 'POST',
      body: JSON.stringify({ hookName, files }),
    }),

  /** Overwrite hook.ts (panel token: new code clears the hook's run as). */
  updateFiles: (hookName: string, files: Partial<HookWorkspaceFiles>) =>
    fetchData<{ workspace: HookWorkspaceInfo }>(getApiUrl(`/hooks/${hookName}/files`), {
      method: 'PUT',
      headers: getPanelJsonHeaders(),
      body: JSON.stringify(files),
    }),

  delete: (hookName: string) =>
    fetchData<HookDeleteResult>(getApiUrl(`/hooks/${encodeURIComponent(hookName)}`), {
      method: 'DELETE',
    }),

  readFile: (hookName: string, fileName: string) =>
    fetchData<{ content: string }>(getApiUrl(`/hooks/${hookName}/files/${fileName}`)).then(
      (data) => data.content
    ),

  /**
   * Durable registration row. `enabled` alone decides whether automatic
   * event/schedule execution is allowed — it is independent of hook.ts,
   * so a disabled hook still builds, saves, and runs from the test console.
   * 404s when the folder scanner has not registered the hook yet.
   */
  status: (hookName: string) =>
    fetchData<HookRegistrationInfo>(getApiUrl(`/hooks/${hookName}/status`)),

  /**
   * Every registration row with what its code declares, for lists that show
   * each hook's `enabled` flag, build state and triggers. Nothing is built.
   */
  registry: () => fetchData<HookRegistryEntry[]>(getApiUrl('/hooks/registry')),

  /** Flip automatic execution on/off without editing hook.ts. */
  setEnabled: (hookName: string, enabled: boolean) =>
    fetchData<HookRegistrationInfo>(
      getApiUrl(`/hooks/${hookName}/${enabled ? 'enable' : 'disable'}`),
      { method: 'POST', headers: getPanelJsonHeaders() }
    ),

  /** What a run this hook wakes does with a tool call that would ask a person. */
  setUnattendedPolicy: (hookName: string, policy: UnattendedPolicy) =>
    fetchData<HookRegistrationInfo>(getApiUrl(`/hooks/${hookName}/unattended-policy`), {
      method: 'PUT',
      headers: getPanelJsonHeaders(),
      body: JSON.stringify({ policy }),
    }),

  /** Build/register the saved hook and report registration + declared meta. */
  check: (hookName: string) =>
    fetchData<HookCheckResult>(getApiUrl(`/hooks/${hookName}/check`), {
      method: 'POST',
      headers: getPanelJsonHeaders(),
    }),

  /**
   * Execute the saved hook (a real run — tool calls act on the live
   * workspace). Node ids resolve into the same payloads their real lifecycle
   * events emit; an explicit `event` object is delivered as-is.
   */
  run: (hookName: string, input: HookRunInput) =>
    fetchData<{ runs: HookTestRun[] }>(getApiUrl(`/hooks/${hookName}/run`), {
      method: 'POST',
      headers: getPanelJsonHeaders(),
      body: JSON.stringify(input),
    }),

  /**
   * Set the agent the hook runs as (its tool access applies, its name goes on
   * what the hook posts and writes), or clear it with null. 400 names an
   * archived, helper or missing agent.
   */
  setRunAs: (hookName: string, agentId: string | null) =>
    fetchData<HookRegistrationInfo>(getApiUrl(`/hooks/${encodeURIComponent(hookName)}/run-as`), {
      method: 'PUT',
      headers: getPanelJsonHeaders(),
      body: JSON.stringify({ agentId }),
    }),
};

export const hookRunsApi = {
  recent: (limit = 25) =>
    fetchData<HookRunRecord[]>(getApiUrl(`/hooks/runs/recent?limit=${limit}`)),

  listForHook: (hookName: string, limit = 100) =>
    fetchData<HookRunRecord[]>(
      getApiUrl(`/hooks/${encodeURIComponent(hookName)}/runs?limit=${limit}`)
    ),

  clearForHook: (hookName: string) =>
    fetchData<HookRunHistoryDeleteResult>(
      getApiUrl(`/hooks/${encodeURIComponent(hookName)}/runs`),
      { method: 'DELETE' }
    ),
};
