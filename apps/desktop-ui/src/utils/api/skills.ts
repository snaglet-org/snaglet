/**
 * Skills API client. Browse is read-only (apps/server/src/routes/skills.ts);
 * assignments use the skill routes on agents and thread participants.
 */
import { fetchData, getApiUrl } from './core';
import { getPanelJsonHeaders } from '../panelToken';

/** A skill exists only while its folder does; there is no 'missing' state. */
type SkillStatus = 'valid' | 'invalid';

export interface SkillInfo {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: SkillStatus;
  error: string | null;
  sourcePath: string;
  folderPath: string;
  version: string | null;
  indexedAt: string;
}

export interface SkillFileEntry {
  path: string;
  size: number;
}

export interface SkillFileContent {
  path: string;
  absolutePath: string;
  content: string;
}

export type SkillMode = 'inherit' | 'add' | 'override';
type SkillOrigin = 'general' | 'thread';
/** 'unknown': no registry row; 'invalid': the row exists but is not valid. */
export type SkillDropReason = 'unknown' | 'invalid';

/** A registry row as the skills routes return it (subset the UI reads). */
interface SkillRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: SkillStatus;
  error: string | null;
}

export interface ThreadSkillState {
  mode: SkillMode;
  threadSkillIds: string[];
  generalSkillIds: string[];
  resolved: {
    effective: { skill: SkillRow; origin: SkillOrigin }[];
    dropped: { skillId: string; origin: SkillOrigin; reason: SkillDropReason }[];
  };
}

const enc = encodeURIComponent;

export const skillsApi = {
  /**
   * The user's own skills. Built-in skills are not listed (every agent always
   * has them), and the file routes answer 404 for one.
   */
  list: () => fetchData<SkillInfo[]>(getApiUrl('/skills')),

  files: (id: string) =>
    fetchData<{ files: SkillFileEntry[]; truncated: boolean }>(
      getApiUrl(`/skills/${enc(id)}/files`)
    ),

  file: (id: string, path: string) =>
    fetchData<SkillFileContent>(getApiUrl(`/skills/${enc(id)}/file?path=${enc(path)}`)),

  /** The agent's general skill defaults. */
  agentSkills: (agentId: string) =>
    fetchData<{ skillIds: string[] }>(getApiUrl(`/agents/${enc(agentId)}/skills`)),

  setAgentSkills: (agentId: string, skillIds: string[]) =>
    fetchData<{ skillIds: string[] }>(getApiUrl(`/agents/${enc(agentId)}/skills`), {
      method: 'PUT',
      body: JSON.stringify({ skillIds }),
    }),

  /** This agent's skill mode + thread picks on a thread, and the resolved set. */
  threadSkills: (threadId: string, agentId: string) =>
    fetchData<ThreadSkillState>(
      getApiUrl(`/threads/${enc(threadId)}/participants/${enc(agentId)}/skills`)
    ),

  setThreadSkills: (
    threadId: string,
    agentId: string,
    patch: { mode?: SkillMode; skillIds?: string[] }
  ) =>
    fetchData<ThreadSkillState>(
      getApiUrl(`/threads/${enc(threadId)}/participants/${enc(agentId)}/skills`),
      { method: 'PUT', body: JSON.stringify(patch) }
    ),

  reveal: (id: string) =>
    fetchData<{ revealed: boolean }>(getApiUrl(`/skills/${enc(id)}/reveal`), {
      method: 'POST',
      headers: getPanelJsonHeaders(),
    }),
};
