import { getDb } from '@snaglet/db';
import {
  workspaceSearchNodes,
  type WorkspaceSearchNodesInput,
  type WorkspaceSearchNodesResult,
} from './nodeSearch';

export type SearchWorkspaceOptions = Omit<WorkspaceSearchNodesInput, 'query'>;

/**
 * Canonical workspace-node retrieval seam.
 *
 * Callers provide the query and explicit retrieval options. Presentation,
 * hydration, filesystem navigation, and interactive fuzzy-path behavior stay
 * in their adapters.
 */
export function searchWorkspace(
  query: string,
  options: SearchWorkspaceOptions
): Promise<WorkspaceSearchNodesResult> {
  return workspaceSearchNodes({ query: query.trim(), ...options });
}

type SearchResultRecord = {
  id: string;
  /** Null for kinds whose entries may legitimately have no title. */
  title?: string | null;
  name?: string;
  relativePath?: string;
};

export async function pinArchivedFirst<T extends SearchResultRecord>(hits: T[]): Promise<T[]> {
  if (hits.length === 0) return hits;
  const { rows } = await getDb().query<{ id: string }>(
    `SELECT id FROM public.nodes WHERE id = ANY($1) AND archived = true`,
    [hits.map((hit) => hit.id)]
  );
  if (rows.length === 0) return hits;
  const archivedIds = new Set(rows.map((row) => row.id));
  const label = (hit: T): T => {
    const marked = { ...hit };
    if (typeof marked.title === 'string') marked.title = `[ARCHIVED] ${marked.title}`;
    else if (typeof marked.name === 'string') marked.name = `[ARCHIVED] ${marked.name}`;
    else if (typeof marked.relativePath === 'string') {
      marked.relativePath = `[ARCHIVED] ${marked.relativePath}`;
    }
    return marked;
  };
  return [
    ...hits.filter((hit) => archivedIds.has(hit.id)).map(label),
    ...hits.filter((hit) => !archivedIds.has(hit.id)),
  ];
}
