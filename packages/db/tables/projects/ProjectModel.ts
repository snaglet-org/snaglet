/**
 * Projects — the project facet over `public.containers`.
 *
 * There is no `projects` table: a project is a container with
 * `category='project'`, and the container id is the project identity. The
 * facet fields (folder_path, github_url, file_indexing_enabled, description,
 * name) live on the containers row; this module is a project-shaped accessor
 * over them. `ProjectRow.containerId` equals `ProjectRow.id`.
 *
 * A project is also a scope: threads (`nodes.project_id`) and tables
 * (`table_catalog.project_id`) point at it, so a project can never stop being
 * one. A container becomes a project at creation or when a user promotes a
 * plain folder (UI and REST only); `assertProjectContainer` is the one check
 * every scope writer runs. A project's description is injected into the scope
 * of agents working inside it.
 */

import { AppError } from '@snaglet/shared/utils';
import { ErrorCode } from '@snaglet/shared/types';
import { getDb, transaction } from '@snaglet/db/db';
import { Nodes, type NodeRunner } from '@snaglet/db/tables/nodes';
import { currentActorMemberId } from '@snaglet/db/actorMember';

export interface ProjectRow {
  id: string;
  name: string;
  githubUrl: string | null;
  folderPath: string | null;
  /** Equals `id`: a project is its container. Used by subtree-scoping callers. */
  containerId: string | null;
  description: string | null;
  /**
   * Whether the linked folder's files are indexed (on for a new project).
   * The fast DB mirror of `embeddings.enabled` in the folder's snaglet.config.json;
   * indexing runs only while both are on.
   */
  fileIndexingEnabled: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ProjectRawRow {
  id: string;
  name: string;
  github_url: string | null;
  folder_path: string | null;
  description: string | null;
  file_indexing_enabled: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectInput {
  /** A container that already carries `category='project'`. */
  containerId: string;
  /** Project name — sets the container's name (project name = container name). */
  name: string;
  githubUrl?: string | null;
  folderPath?: string | null;
  description?: string | null;
}

export interface UpdateProjectInput {
  name?: string;
  githubUrl?: string | null;
  folderPath?: string | null;
  description?: string | null;
  fileIndexingEnabled?: boolean;
}

interface ListProjectsOptions {
  orderBy?: 'updated_at' | 'created_at' | 'name';
  order?: 'ASC' | 'DESC';
}

const PROJECT_SELECT = `
  SELECT c.id, c.name, c.github_url, c.folder_path, c.description, c.file_indexing_enabled,
         n.archived, n.created_at, n.updated_at
  FROM public.containers c
  JOIN public.nodes n ON n.id = c.id
  WHERE c.category = 'project'
`;

function mapProjectRow(raw: ProjectRawRow): ProjectRow {
  return {
    id: raw.id,
    name: raw.name,
    githubUrl: raw.github_url,
    folderPath: raw.folder_path,
    // A project is its container: identity and subtree root are the same id.
    containerId: raw.id,
    description: raw.description,
    fileIndexingEnabled: raw.file_indexing_enabled,
    archived: raw.archived,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

class ProjectModelClass {
  /** Serialize ownership decisions with every container INSERT/UPDATE, including
   * callers outside this model. Keep filesystem alias changes in this callback.
   * READ COMMITTED reads after the lock observe the preceding writer's commit.
   */
  async withFolderWriteLock<T>(fn: (runner: NodeRunner) => Promise<T>): Promise<T> {
    return transaction(async (tx) => {
      await tx.query('LOCK TABLE public.nodes, public.containers IN SHARE ROW EXCLUSIVE MODE');
      return fn(tx);
    });
  }

  /**
   * Write the project facet onto a container that already carries
   * `category='project'`: adopt `name` as the container name (project name =
   * container name) and set the facet fields. A container of any other
   * category is refused here (see `assertProjectContainer`).
   */
  async create(input: CreateProjectInput, runner?: NodeRunner): Promise<ProjectRow> {
    if (!runner) return this.withFolderWriteLock((tx) => this.create(input, tx));
    await this.assertProjectContainer(input.containerId, runner);
    // Facet edit on an existing container (created_by stays as its original
    // creator) — stamp last_edited_by with the acting member. Bypasses
    // ContainerModel.update, so the edit stamp is applied inline here.
    const editedBy = await currentActorMemberId();
    await runner.query(
      `UPDATE public.containers
          SET name           = $2,
              github_url     = $3,
              folder_path    = $4,
              description    = COALESCE($5, description),
              last_edited_by = $6
        WHERE id = $1 AND category = 'project'`,
      [
        input.containerId,
        input.name,
        input.githubUrl ?? null,
        input.folderPath ?? null,
        input.description ?? null,
        editedBy,
      ]
    );
    await Nodes.touch(input.containerId, runner);
    const row = await this.findById(input.containerId, runner);
    if (!row) {
      throw new Error(
        `Projects.create: project container ${input.containerId} missing after write`
      );
    }
    return row;
  }

  async findById(id: string, runner: NodeRunner = getDb()): Promise<ProjectRow | null> {
    const { rows } = await runner.query<ProjectRawRow>(`${PROJECT_SELECT} AND c.id = $1`, [id]);
    return rows[0] ? mapProjectRow(rows[0]) : null;
  }

  async findByName(name: string): Promise<ProjectRow | null> {
    const { rows } = await getDb().query<ProjectRawRow>(
      `${PROJECT_SELECT} AND c.name = $1 ORDER BY n.updated_at DESC LIMIT 1`,
      [name]
    );
    return rows[0] ? mapProjectRow(rows[0]) : null;
  }

  async listAll(runner: NodeRunner = getDb()): Promise<ProjectRow[]> {
    const { rows } = await runner.query<ProjectRawRow>(`${PROJECT_SELECT} ORDER BY c.name ASC`);
    return rows.map(mapProjectRow);
  }

  async list(options: ListProjectsOptions = {}): Promise<ProjectRow[]> {
    const column =
      options.orderBy === 'created_at'
        ? 'n.created_at'
        : options.orderBy === 'name'
          ? 'c.name'
          : 'n.updated_at';
    const direction = options.order === 'ASC' ? 'ASC' : 'DESC';
    const { rows } = await getDb().query<ProjectRawRow>(
      `${PROJECT_SELECT} ORDER BY ${column} ${direction}`
    );
    return rows.map(mapProjectRow);
  }

  async update(
    id: string,
    input: UpdateProjectInput,
    runner?: NodeRunner
  ): Promise<ProjectRow | null> {
    if (input.folderPath !== undefined && !runner) {
      return this.withFolderWriteLock((tx) => this.update(id, input, tx));
    }
    const r = runner ?? getDb();
    const sets: string[] = [];
    const values: unknown[] = [];
    if (input.name !== undefined) {
      values.push(input.name);
      sets.push(`name = $${values.length}`);
    }
    if (input.githubUrl !== undefined) {
      values.push(input.githubUrl);
      sets.push(`github_url = $${values.length}`);
    }
    if (input.folderPath !== undefined) {
      values.push(input.folderPath);
      sets.push(`folder_path = $${values.length}`);
    }
    if (input.description !== undefined) {
      values.push(input.description);
      sets.push(`description = $${values.length}`);
    }
    if (input.fileIndexingEnabled !== undefined) {
      values.push(input.fileIndexingEnabled);
      sets.push(`file_indexing_enabled = $${values.length}`);
    }
    if (sets.length === 0) return this.findById(id, r);

    // Facet edit (name/git/folder/description/indexing) — stamp last_edited_by
    // with the acting member. Bypasses ContainerModel.update, so applied inline.
    values.push(await currentActorMemberId());
    sets.push(`last_edited_by = $${values.length}`);

    values.push(id);
    const { rowCount } = await r.query(
      `UPDATE public.containers SET ${sets.join(', ')}
        WHERE id = $${values.length} AND category = 'project'`,
      values
    );
    if ((rowCount ?? 0) === 0) return null;
    await Nodes.touch(id, r);
    return this.findById(id, r);
  }

  /**
   * Refuse a project scope target that is not a live project container. The
   * one check every scope writer (`Threads.setProject`,
   * `TableCatalog.setProject`, thread creation) runs before writing a
   * `project_id`; the database repeats the category half of it in
   * `trg_nodes_project_scope_guard` / `trg_table_catalog_project_scope_guard`
   * for raw writes. `null` (flat / workspace-wide) always passes. `FOR SHARE`
   * holds the container's node row until the caller's transaction ends so a
   * concurrent archive or delete waits for the scope write to commit.
   */
  async assertProjectContainer(projectId: string | null, runner?: NodeRunner): Promise<void> {
    if (projectId === null) return;
    const r = runner ?? getDb();
    const { rows } = await r.query<{
      type: string;
      archived: boolean;
      category: string | null;
    }>(
      `SELECT n.type::text AS type, n.archived, c.category
         FROM public.nodes n
         LEFT JOIN public.containers c ON c.id = n.id
        WHERE n.id = $1
        FOR SHARE OF n`,
      [projectId]
    );
    const target = rows[0];
    if (!target) {
      throw new AppError(`Project ${projectId} not found`, ErrorCode.NOT_FOUND, 404);
    }
    if (target.type !== 'container' || target.category !== 'project') {
      throw new AppError(
        `${projectId} is not a project: only a container with category='project' can scope threads and tables`,
        ErrorCode.VALIDATION_ERROR,
        400
      );
    }
    if (target.archived) {
      throw new AppError(
        `Project ${projectId} is archived; restore it or choose a live project`,
        ErrorCode.VALIDATION_ERROR,
        400
      );
    }
  }

  /**
   * The nearest project container at or above `containerId` in the folder
   * tree (the container itself first, then its ancestors), or null when none
   * of them is a project. This is how a thread created "where I am" (from a
   * doc or folder) finds its scope.
   */
  async nearestProjectForContainer(
    containerId: string | null,
    runner?: NodeRunner
  ): Promise<string | null> {
    if (containerId === null) return null;
    const r = runner ?? getDb();
    const { rows } = await r.query<{ id: string }>(
      `WITH RECURSIVE chain AS (
         SELECT n.id, n.container_id, 0 AS depth
           FROM public.nodes n
          WHERE n.id = $1 AND n.type = 'container'
         UNION ALL
         SELECT n.id, n.container_id, chain.depth + 1
           FROM chain
           JOIN public.nodes n ON n.id = chain.container_id
          WHERE chain.depth < 128
       )
       SELECT chain.id
         FROM chain
         JOIN public.containers c ON c.id = chain.id
        WHERE c.category = 'project'
        ORDER BY chain.depth
        LIMIT 1`,
      [containerId]
    );
    return rows[0]?.id ?? null;
  }
}

export const Projects = new ProjectModelClass();
