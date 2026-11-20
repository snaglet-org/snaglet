/**
 * PlacementEventModel — public.placement_events.
 *
 * Permanent placement ledger: written from the per-model `moveTo()`
 * chokepoint for every node kind (doc, container, thread, image) and never
 * pruned. Only moves that change the container are recorded; reorders within
 * a container and `create()` (which sets the initial container itself)
 * produce no event.
 *
 * `from_container_id` / `to_container_id` have no FK, so deleting a container
 * never rewrites move history; `node_id` cascades with the node. `moved_by`
 * FKs to members(id) ON DELETE SET NULL. `record()` ignores any caller-supplied
 * `movedBy` (callers pass a raw user or agent id, not a members.id) and
 * resolves the acting member itself through `@snaglet/db/actorMember`.
 */

import { generateId } from '@snaglet/shared/utils';
import { Model } from '@snaglet/db/Model';
import type { NodeRunner } from '@snaglet/db/tables/nodes';
import { currentActorMemberId } from '@snaglet/db/actorMember';

export interface PlacementEventRow {
  id: string;
  nodeId: string;
  fromContainerId: string | null;
  toContainerId: string | null;
  movedBy: string | null;
  movedAt: string;
}

export interface RecordPlacementInput {
  nodeId: string;
  fromContainerId: string | null;
  toContainerId: string | null;
  /**
   * @deprecated ignored by `record()` (see the class header): the acting
   * member is resolved internally via `currentActorMemberId()`, since callers
   * supply a raw actor id here, not a members.id. Kept so the `moveTo()`
   * methods and their callers need no signature change.
   */
  movedBy?: string | null;
  /** Optional tx runner so the write shares the caller's transaction. */
  runner?: NodeRunner;
}

interface PlacementEventRawRow {
  id: string;
  node_id: string;
  from_container_id: string | null;
  to_container_id: string | null;
  moved_by: string | null;
  moved_at: string;
}

function mapRow(raw: PlacementEventRawRow): PlacementEventRow {
  return {
    id: raw.id,
    nodeId: raw.node_id,
    fromContainerId: raw.from_container_id,
    toContainerId: raw.to_container_id,
    movedBy: raw.moved_by,
    movedAt: raw.moved_at,
  };
}

class PlacementEventModelClass extends Model<PlacementEventRow> {
  constructor() {
    super({
      table: 'placement_events',
      primaryKey: 'id',
      updatedAtColumn: null,
      createdAtColumn: null,
    });
  }

  /**
   * Record a container-changing move. No-op when the container did not change
   * (a pure reorder) — `moveTo` calls this unconditionally and this guard keeps
   * reorders out of the history. Best-effort attribution: resolves the acting
   * member from the ambient actor context (`currentActorMemberId()`), NULL
   * when unattributable. `input.movedBy` (a raw actor id) is not used; see the
   * class header.
   */
  async record(input: RecordPlacementInput): Promise<void> {
    const from = input.fromContainerId ?? null;
    const to = input.toContainerId ?? null;
    if (from === to) return; // reorder within the same container — not a move
    const runner = input.runner ?? this.pool;
    const movedBy = await currentActorMemberId();
    await runner.query(
      `INSERT INTO public.placement_events
         (id, node_id, from_container_id, to_container_id, moved_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [generateId('placement'), input.nodeId, from, to, movedBy]
    );
  }

  /** History for a node, newest first. Exists mainly for tests / future reads. */
  async listByNode(nodeId: string, limit = 100): Promise<PlacementEventRow[]> {
    const raws = await this.rawQuery<PlacementEventRawRow>(
      `SELECT id, node_id, from_container_id, to_container_id, moved_by, moved_at
         FROM public.placement_events
        WHERE node_id = $1
        ORDER BY moved_at DESC, id DESC
        LIMIT $2`,
      [nodeId, limit]
    );
    return raws.map(mapRow);
  }
}

export const PlacementEvents = new PlacementEventModelClass();
