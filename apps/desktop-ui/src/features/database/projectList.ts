/**
 * The app's one project list: the Database sidebar's grouping, the table
 * pane's project picker and the thread settings' project picker all read it.
 *
 * A project is a container with `category === 'project'`, and the workspace
 * tree is the one place the app lists them, so this reads
 * `containersApi.listTree()` once and flattens every project container
 * (nested ones included) into a name-sorted list shared by every sidebar and
 * pane that mounts. Each option carries the names of the containers above
 * it so pickers can disambiguate nested projects. Library events keep the
 * list current without a refetch where they can: a container rename patches
 * a flat project's name in place; a created project, a deleted container, an
 * archive or restore, a tree-shape change from another client, or a rename
 * while nested projects exist (the renamed container may sit above one)
 * refetches, since lineage is only readable off the tree.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { compareByName, getErrorMessage } from '@snaglet/shared/utils';
import { containersApi, type LibraryTreeChild } from '@desktop/utils/api';
import { onLibraryEvent } from '@desktop/utils/workspaceEvents';

/** A project container as a picker option: its id, name and ancestor names. */
export interface ProjectOption {
  /** The project container's id. */
  id: string;
  name: string;
  /** Ancestor container names, topmost first — disambiguates nested projects. */
  ancestors: string[];
  /** The folder on disk the project links, when it links one. */
  folderPath?: string;
}

export interface ProjectListState {
  /** Sorted by name; `null` until the first successful load. */
  projects: ProjectOption[] | null;
  /** The last load failure; a later success clears it. */
  error: string | null;
}

/**
 * Every project container in the tree, nested ones included, sorted by name,
 * each with the names of the containers above it (topmost first).
 */
export function collectProjects(tree: LibraryTreeChild[]): ProjectOption[] {
  const found: ProjectOption[] = [];
  const walk = (nodes: LibraryTreeChild[], ancestors: string[]) => {
    for (const node of nodes) {
      if (node.kind !== 'container') continue;
      const name = node.name || 'Untitled';
      if (node.category === 'project') {
        found.push({
          id: node.id,
          name,
          ancestors,
          ...(node.folderPath ? { folderPath: node.folderPath } : {}),
        });
      }
      walk(node.children ?? [], [...ancestors, name]);
    }
  };
  walk(tree, []);
  return found.sort(compareByName);
}

let state: ProjectListState = { projects: null, error: null };
let pending: Promise<void> | null = null;
let reloadAfterPending = false;
let listening = false;
const listeners = new Set<() => void>();

function setState(next: ProjectListState): void {
  state = next;
  for (const listener of listeners) listener();
}

function load(): Promise<void> {
  if (pending) return pending;
  // Deferred so a synchronous throw lands in the catch, not in the caller.
  pending = Promise.resolve()
    .then(() => containersApi.listTree())
    .then((tree) => setState({ projects: collectProjects(tree ?? []), error: null }))
    .catch((err: unknown) => {
      setState({ ...state, error: getErrorMessage(err, 'Failed to load projects') });
    })
    .finally(() => {
      pending = null;
      if (reloadAfterPending) {
        reloadAfterPending = false;
        void load();
      }
    });
  return pending;
}

/** Refetch, or queue one refetch behind the load in flight. */
function reloadProjects(): void {
  if (pending) reloadAfterPending = true;
  else void load();
}

function listenToLibraryEvents(): void {
  if (listening) return;
  listening = true;
  onLibraryEvent((event) => {
    const { projects } = state;
    switch (event.type) {
      case 'renamed': {
        if (event.kind !== 'container' || !projects) return;
        // The renamed container may be an ancestor of a nested project, whose
        // lineage only the tree knows; names are not ids, so refetch.
        if (projects.some((project) => project.ancestors.length > 0)) {
          reloadProjects();
          return;
        }
        if (!projects.some((project) => project.id === event.id)) return;
        setState({
          ...state,
          projects: projects
            .map((project) =>
              project.id === event.id ? { ...project, name: event.name } : project
            )
            .sort(compareByName),
        });
        return;
      }
      case 'created':
        // A new project's lineage is only readable off the tree; refetch.
        if (projects && event.node.kind === 'container' && event.node.category === 'project') {
          reloadProjects();
        }
        return;
      case 'deleted':
        // A deleted folder takes any nested projects with it; refetch rather than guess.
        if (event.kind === 'container' && projects) reloadProjects();
        return;
      case 'archive-changed':
      case 'tree-invalidated':
        if (projects || pending) reloadProjects();
        return;
      default:
        return;
    }
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Test-only: forget the loaded list so each case starts unloaded.
 * Tagged `@public` because Knip does not scan test files.
 * @public
 */
export function __resetProjectListForTests(): void {
  state = { projects: null, error: null };
  pending = null;
  reloadAfterPending = false;
}

/** The project's current name, or `null` when the list has no such project. */
export function projectNameOf(projects: ProjectOption[] | null, id: string): string | null {
  return projects?.find((project) => project.id === id)?.name ?? null;
}

/**
 * Display label for a project id: its name when listed; otherwise "Archived
 * project" once the list has loaded (a table or thread may stay scoped to a
 * project the tree does not show), or a loading placeholder before then.
 * `loaded` defaults to whether `projects` is present.
 */
export function projectLabel(
  projectId: string,
  projects: ProjectOption[] | null,
  { loaded = projects !== null }: { loaded?: boolean } = {}
): string {
  return projectNameOf(projects, projectId) ?? (loaded ? 'Archived project' : 'Loading project…');
}

/** Select option text — nested projects are prefixed with their lineage. */
export function projectOptionLabel(project: ProjectOption): string {
  return [...project.ancestors, project.name].join(' / ');
}

/**
 * The folders linked to projects, from the shared list; `null` until it has
 * loaded. Loads only while `enabled`, so a caller that may not need it costs
 * nothing.
 */
export function useLinkedProjectFolders(enabled: boolean): string[] | null {
  const snapshot = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    if (!enabled) return;
    listenToLibraryEvents();
    if (!state.projects && !pending) void load();
  }, [enabled]);
  return useMemo(
    () =>
      snapshot.projects?.flatMap((project) => (project.folderPath ? [project.folderPath] : [])) ??
      null,
    [snapshot]
  );
}

/** The shared project list; loads on first use and follows library events. */
export function useProjectList(): ProjectListState & { reload: () => void } {
  const snapshot = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    listenToLibraryEvents();
    if (!state.projects && !pending) void load();
  }, []);
  return useMemo(() => ({ ...snapshot, reload: reloadProjects }), [snapshot]);
}
