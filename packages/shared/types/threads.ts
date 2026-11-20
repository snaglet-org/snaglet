/**
 * Thread HTTP request shapes shared by the server thread routes and the
 * desktop UI.
 *
 * Threads are not placed in the folder tree. A thread is scoped to a project
 * container (`projectId`, a container with `category = 'project'`) or is flat
 * at the workspace level (`null`). No thread request accepts a container.
 */

export type ThreadDispatchMode = 'all' | 'mentioned';

/**
 * Longest a thread title may be. A fork prefills the title from the source
 * (agent name + date), and a pasted or edited title could run long, so the
 * fork route clamps to this and the dialog's input stops typing past it.
 */
export const THREAD_TITLE_MAX_LENGTH = 200;

/** POST /api/threads */
export interface CreateThreadRequest {
  title?: string;
  /** First agent participant. */
  agentId?: string;
  /** First user participant. */
  userId?: string;
  /** Project scope; omitted or null creates a flat thread. */
  projectId?: string | null;
}

/**
 * PATCH /api/threads/:id. Every field is written only when present; an
 * explicit null clears it. `projectId: null` moves the thread out of its
 * project to the workspace level.
 */
export interface UpdateThreadRequest {
  title?: string;
  projectId?: string | null;
  dispatchMode?: ThreadDispatchMode;
  /** `-1` = unbounded, null = settings default. */
  maxWaves?: number | null;
  maxTotalOutputTokens?: number | null;
  maxAgentDispatches?: number | null;
  threadSystemPrompt?: string | null;
}
