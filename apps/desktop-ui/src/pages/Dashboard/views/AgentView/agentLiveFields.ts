/**
 * The agent pane's live fields: what each shown setting reads from the agent
 * row, how a server `changed` key maps onto it, and who to credit for a change.
 *
 * Comparison runs on what the pane shows, not on every row key: the identity
 * and system prompt editors show the raw stored text, so a linked doc that
 * changes only the expanded text is not a change here.
 */

import type { SnagletAgent } from '@snaglet/shared/types';
import type { Actor } from '@snaglet/shared/types/workspace-events';

/** A setting group (or header item) of the agent pane that can change remotely. */
export type AgentLiveField =
  | 'name'
  | 'avatar'
  | 'role'
  | 'model'
  | 'voice'
  | 'identity'
  | 'systemPrompt'
  | 'dmEnabled'
  | 'tools'
  | 'mcpServers'
  | 'skills'
  | 'archived';

/** Free-text fields the user types into: a remote change there may meet a draft. */
export type AgentDraftField = 'role' | 'identity' | 'systemPrompt';

export const AGENT_DRAFT_FIELDS: readonly AgentDraftField[] = ['role', 'identity', 'systemPrompt'];

/** A remote change waiting on the user's choice, because they were editing that field. */
export interface LiveConflict {
  /** The value now saved on the server. */
  remote: string;
  /** Who changed it, ready to read: "Patty", "an automation". */
  by: string;
}

/** Says whether the user is editing a field right now (focused, or an unsaved draft). */
export type EditingProbe = { current: (() => boolean) | null };

/**
 * True while a field's saves must wait: a change to it is on its way (its
 * refetch has not landed) or is open as a conflict. Read at save time.
 */
export type SaveGate = { current: boolean };

/** How a field's conflict ended. */
export interface ConflictChoice {
  /**
   * Keep mine: the conflict the user answered, and the text they kept. If a
   * newer change arrived meanwhile, that one stays open over the kept text.
   */
  keptOver?: LiveConflict;
  kept?: string;
}

const ROW_FIELDS: Record<Exclude<AgentLiveField, 'skills'>, (agent: SnagletAgent) => unknown> = {
  name: (a) => a.name ?? '',
  avatar: (a) => [a.cursorSpec ?? null, a.avatarUrl ?? null],
  role: (a) => a.role ?? '',
  model: (a) => [
    a.provider ?? null,
    a.modelId ?? null,
    a.credentialId ?? null,
    a.disableModelFallback === true,
  ],
  voice: (a) => a.voice ?? null,
  identity: (a) => a.rawIdentity ?? a.identity ?? '',
  systemPrompt: (a) => a.rawSystemPrompt ?? a.systemPrompt ?? '',
  dmEnabled: (a) => a.dmEnabled !== false,
  tools: (a) => [
    a.toolAccessMode ?? null,
    a.toolAccessAllowList ?? null,
    a.toolAccessDenyList ?? null,
    a.toolOverrides ?? null,
    a.trustedToolCalls === true,
  ],
  mcpServers: (a) => a.mcpServers ?? [],
  archived: (a) => a.archived === true,
};

/** The text a draft field shows for this agent. */
export function draftFieldValue(field: AgentDraftField, agent: SnagletAgent): string {
  return ROW_FIELDS[field](agent) as string;
}

/** The shown fields that differ between two copies of one agent. */
export function changedLiveFields(before: SnagletAgent, after: SnagletAgent): AgentLiveField[] {
  return (Object.keys(ROW_FIELDS) as Array<keyof typeof ROW_FIELDS>).filter(
    (field) =>
      JSON.stringify(ROW_FIELDS[field](before)) !== JSON.stringify(ROW_FIELDS[field](after))
  );
}

/** Server `changed` keys (agent row columns, as the API names them) per pane field. */
const EVENT_KEY_FIELD: Record<string, AgentLiveField> = {
  name: 'name',
  avatarUrl: 'avatar',
  cursorSpec: 'avatar',
  cursorFlower: 'avatar',
  cursorColor: 'avatar',
  role: 'role',
  providerId: 'model',
  modelId: 'model',
  credentialId: 'model',
  disableModelFallback: 'model',
  voice: 'voice',
  identity: 'identity',
  systemPrompt: 'systemPrompt',
  dmEnabled: 'dmEnabled',
  toolAccessMode: 'tools',
  toolAccessAllowList: 'tools',
  toolAccessDenyList: 'tools',
  toolOverrides: 'tools',
  trustedToolCalls: 'tools',
  mcpServers: 'mcpServers',
  skills: 'skills',
  archived: 'archived',
};

/** The pane field a server `changed` key belongs to, if the pane shows it. */
export function liveFieldOfKey(key: string): AgentLiveField | null {
  return EVENT_KEY_FIELD[key] ?? null;
}

/** Keys whose change leaves the agent row alone: a row refetch would find nothing. */
export function isRowIndependentKey(key: string): boolean {
  return key === 'skills';
}

/** Who made a change, in words for "Updated by … just now". */
export function describeActor(actor: Actor | null | undefined): string {
  if (!actor) return 'someone else';
  const name = actor.actorName?.trim();
  switch (actor.actorKind) {
    case 'agent':
      return name || 'an agent';
    case 'user':
      return name || 'you, in another window';
    case 'external':
      return name || 'an outside app';
    default:
      return 'an automation';
  }
}

/** A 404 from the agents API (a FetchError): the agent no longer exists. */
export function isNotFound(err: unknown): boolean {
  return (err as { status?: unknown } | null)?.status === 404;
}

type AgentPatchKey = keyof SnagletAgent;

/**
 * Apply a save's response to the pane's copy, taking only the fields the save
 * wrote (and the new revision). The response holds every field as the server
 * has it now; taking the rest would slip in another writer's change with no
 * notice, and past a draft in a field the user is editing.
 */
export function adoptSavedFields(
  current: SnagletAgent,
  saved: SnagletAgent,
  patch: object
): SnagletAgent {
  const next: SnagletAgent = { ...current, updatedAt: saved.updatedAt };
  const take = (key: AgentPatchKey) => {
    (next as unknown as Record<string, unknown>)[key] = saved[key];
  };
  for (const key of Object.keys(patch) as AgentPatchKey[]) {
    take(key);
    if (key === 'systemPrompt') take('rawSystemPrompt');
    if (key === 'identity') take('rawIdentity');
  }
  return next;
}
