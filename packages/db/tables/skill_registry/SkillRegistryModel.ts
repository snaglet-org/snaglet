import { Model } from '@snaglet/db/Model';

/**
 * 'personal': ~/.snaglet/skills (the user's own). 'builtin': ships with Snaglet, usable
 * by every agent without an assignment. 'project': unused; the startup sweep
 * deletes any such row.
 */
export type SkillScope = 'personal' | 'project' | 'builtin';
/**
 * A row exists only while its SKILL.md folder does: a vanished folder deletes
 * the row (and, via the FK cascade, its assignments). The DB CHECK also allows
 * 'missing', but nothing writes it, and the startup sweep deletes any such row.
 */
export type SkillStatus = 'valid' | 'invalid';

export interface SkillRegistryRow {
  id: string;
  scope: SkillScope;
  projectId: string | null;
  slug: string;
  name: string;
  description: string;
  sourcePath: string;
  contentHash: string | null;
  status: SkillStatus;
  error: string | null;
  indexedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillUpsertInput {
  id: string;
  scope: SkillScope;
  projectId: string | null;
  slug: string;
  name: string;
  description: string;
  sourcePath: string;
  contentHash: string | null;
  status: SkillStatus;
  error: string | null;
}

type CreateSkillInput = SkillUpsertInput;
type UpdateSkillInput = Partial<Omit<SkillUpsertInput, 'id' | 'scope' | 'projectId' | 'slug'>>;

/** Personal skills have no project; compare with IS NOT DISTINCT FROM. */
const SCOPE_MATCH = 'scope=$1 AND project_id IS NOT DISTINCT FROM $2';

class SkillRegistryModelClass extends Model<SkillRegistryRow, CreateSkillInput, UpdateSkillInput> {
  constructor() {
    super({ table: 'skill_registry', primaryKey: 'id' });
  }

  async listAll(): Promise<SkillRegistryRow[]> {
    return this.query<SkillRegistryRow>(
      'SELECT * FROM skill_registry ORDER BY scope, project_id NULLS FIRST, slug'
    );
  }

  /** Valid built-in skills, by slug. Every agent gets these without an assignment. */
  async listBuiltinValid(): Promise<SkillRegistryRow[]> {
    return this.query<SkillRegistryRow>(
      `SELECT * FROM skill_registry WHERE scope='builtin' AND status='valid' ORDER BY slug`
    );
  }

  async listForRoot(scope: SkillScope, projectId: string | null): Promise<SkillRegistryRow[]> {
    return this.query<SkillRegistryRow>(
      `SELECT * FROM skill_registry WHERE ${SCOPE_MATCH} ORDER BY slug`,
      [scope, projectId]
    );
  }

  async findBySlug(
    scope: SkillScope,
    projectId: string | null,
    slug: string
  ): Promise<SkillRegistryRow | null> {
    return this.queryOne<SkillRegistryRow>(
      `SELECT * FROM skill_registry WHERE ${SCOPE_MATCH} AND slug=$3 LIMIT 1`,
      [scope, projectId, slug]
    );
  }

  /**
   * Insert or refresh a skill found on disk. The id stays stable for an
   * existing (scope, project, slug), so assignments survive edits to it.
   */
  async upsertDiscovered(input: SkillUpsertInput): Promise<SkillRegistryRow> {
    const existing = await this.findBySlug(input.scope, input.projectId, input.slug);
    if (existing) {
      const rows = await this.query<SkillRegistryRow>(
        `UPDATE skill_registry SET name=$2, description=$3, source_path=$4, content_hash=$5,
           status=$6, error=$7, indexed_at=now(), updated_at=now()
         WHERE id=$1 RETURNING *`,
        [
          existing.id,
          input.name,
          input.description,
          input.sourcePath,
          input.contentHash,
          input.status,
          input.error,
        ]
      );
      return rows[0];
    }
    const rows = await this.query<SkillRegistryRow>(
      `INSERT INTO skill_registry
         (id, scope, project_id, slug, name, description, source_path, content_hash, status, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        input.id,
        input.scope,
        input.projectId,
        input.slug,
        input.name,
        input.description,
        input.sourcePath,
        input.contentHash,
        input.status,
        input.error,
      ]
    );
    return rows[0];
  }

  /**
   * A folder vanished: delete its row. skill_assignments.skill_id is ON DELETE
   * CASCADE, so the skill's assignments go with it.
   */
  async deleteBySlug(
    scope: SkillScope,
    projectId: string | null,
    slug: string
  ): Promise<SkillRegistryRow | null> {
    return this.queryOne<SkillRegistryRow>(
      `DELETE FROM skill_registry WHERE ${SCOPE_MATCH} AND slug=$3 RETURNING *`,
      [scope, projectId, slug]
    );
  }

  /**
   * Startup sweep: delete rows that should not exist: every `project` row
   * (project skill folders are not scanned) and any `missing` row (skills are
   * deleted when their folder vanishes). Returns how many went.
   */
  async deleteRetiredRows(): Promise<number> {
    const rows = await this.query<{ id: string }>(
      `DELETE FROM skill_registry WHERE scope='project' OR status='missing' RETURNING id`
    );
    return rows.length;
  }
}

export const SkillRegistry = new SkillRegistryModelClass();
