/**
 * resolveAgentCwd — determine the working directory for an agent's tool calls.
 *
 * Priority waterfall (highest priority first):
 *   0. Validated person-managed thread worktree directory.
 *   1. Project folder — if the thread's project (`nodes.project_id`) has a
 *      linked folder, use the project's real absolute `folder_path` on disk.
 *   2. `~/.snaglet` — fallback when there is no linked folder.
 *
 * The resolved path is created if it doesn't exist (for the ~/.snaglet fallback).
 */

import { mkdir } from 'fs/promises';
import { Threads } from '@snaglet/db/tables/threads';
import { validateThreadWorkingDirectory } from './threadWorkingDirectory';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { SNAGLET_HOME } from '@server/services/snagletHome';
import { findProjectAncestor } from '@server/services/ToolService/lib/findProjectAncestor';

const LOG_PREFIX = '[resolveAgentCwd]';

/**
 * Look up the folder_path for the project a thread is scoped to. Returns null
 * if the thread is flat or the project has no folder_path.
 */
async function getThreadProjectFolderPath(threadId: string): Promise<string | null> {
  try {
    const ancestor = await findProjectAncestor(threadId);
    return ancestor?.folderPath ?? null;
  } catch (error) {
    logger.warn('[AgentCwd] Failed to resolve project folder path', {
      threadId,
      error: getErrorMessage(error),
    });
    return null;
  }
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // best-effort — the dir may already exist or be read-only
  }
}

/** Where a thread's working directory comes from, nearest first. */
export type AgentCwdSource = 'thread' | 'project' | 'home';

export interface AgentCwdDescription {
  /** Absolute path agents start in. */
  path: string;
  source: AgentCwdSource;
  /** The thread's project folder on disk, when it has one. */
  projectFolder: string | null;
  /** The nearest saved override (this thread's or a parent thread's), valid or not. */
  override: string | null;
  /** Set when that override does not validate (its folder moved or was removed). */
  overrideProblem: string | null;
}

/**
 * Work out the working directory for an agent run and where it came from
 * (the waterfall above), without creating anything. The settings UI shows
 * this, and {@link resolveAgentCwd} runs it, so what a person sees is what an
 * agent gets.
 */
export async function describeAgentCwd(threadId?: string): Promise<AgentCwdDescription> {
  let projectFolder: string | null = null;
  let override: string | null = null;
  let overrideProblem: string | null = null;
  // 1. A saved, still-valid thread folder; 2. the project folder on disk.
  if (threadId) {
    projectFolder = (await getThreadProjectFolderPath(threadId))?.trim() || null;
    try {
      // Parent links are server-owned; inherited paths still use this thread's roots.
      const visited = new Set<string>();
      let current: string | null = threadId;
      while (current && !visited.has(current) && visited.size < 32) {
        visited.add(current);
        const thread = await Threads.findById(current);
        if (thread?.workingDirectory != null) {
          override = thread.workingDirectory;
          try {
            const path = await validateThreadWorkingDirectory(override, projectFolder);
            return { path, source: 'thread', projectFolder, override, overrideProblem: null };
          } catch (error) {
            overrideProblem = getErrorMessage(error);
            logger.warn(`${LOG_PREFIX} invalid thread working directory; using existing fallback`, {
              threadId,
              error: overrideProblem,
            });
            break; // Invalid nearest override must not select a more distant one.
          }
        }
        current = thread?.parentThreadId ?? null;
      }
    } catch (error) {
      logger.warn(
        `${LOG_PREFIX} failed to read thread working directory; using existing fallback`,
        {
          threadId,
          error: getErrorMessage(error),
        }
      );
    }
    if (projectFolder) {
      return { path: projectFolder, source: 'project', projectFolder, override, overrideProblem };
    }
  }
  // 3. Default: ~/.snaglet
  return { path: SNAGLET_HOME, source: 'home', projectFolder, override, overrideProblem };
}

/**
 * Resolve the working directory for an agent run, and where it came from.
 * Creates the Snaglet home fallback when that is what applies.
 */
export async function resolveAgentCwdWithSource(
  threadId?: string
): Promise<{ path: string; source: AgentCwdSource }> {
  const described = await describeAgentCwd(threadId);
  if (described.source === 'home') await ensureDir(SNAGLET_HOME);
  logger.debug(`${LOG_PREFIX} resolved cwd from ${described.source}: ${described.path}`);
  return { path: described.path, source: described.source };
}

/**
 * Resolve the working directory for an agent run.
 *
 * @param threadId — the thread the agent is operating in (resolves project context)
 * @returns absolute path to use as cwd for tool execution
 */
export async function resolveAgentCwd(threadId?: string): Promise<string> {
  return (await resolveAgentCwdWithSource(threadId)).path;
}
