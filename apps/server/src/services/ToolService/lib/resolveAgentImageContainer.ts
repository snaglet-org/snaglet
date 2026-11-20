import { transaction } from '@snaglet/db/db';
import { currentActorMemberId } from '@snaglet/db/actorMember';
import { Containers } from '@snaglet/db/tables/containers';
import { Threads } from '@snaglet/db/tables/threads';
import { Nodes } from '@snaglet/db/tables/nodes';
import { generateId } from '@snaglet/shared/utils';
import { emitTreeNodeCreated, snapshotFromContainer } from '@server/realtime/surfaces/tree';

/** Initial agent-image placement only. Never called by image moves or human uploads. */
export async function resolveAgentImageContainer(
  threadId?: string | null,
  sourceContainerId?: string | null
): Promise<string> {
  let scope = sourceContainerId;
  if (scope === undefined) {
    const thread = threadId ? await Threads.findById(threadId) : null;
    if (threadId && !thread) throw new Error('Image destination: thread no longer exists');
    scope = thread?.projectId ?? null;
  }
  // An explicit destination only selects the project; it is not an escape from Images.
  let projectId: string | null = null;
  const seen = new Set<string>();
  while (scope) {
    if (seen.has(scope)) throw new Error('Image destination: container cycle');
    seen.add(scope);
    const container = await Containers.findById(scope);
    if (!container) throw new Error('Image destination is missing');
    if (container.archived) throw new Error('Image destination is archived');
    if (container.category === 'project') {
      projectId = container.id;
      break;
    }
    scope = container.parentId;
  }
  const createdBy = await currentActorMemberId();
  const result = await transaction(async (tx) => {
    // Transaction lock works across processes and releases on rollback, too.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `agent-images:${projectId ?? 'root'}`,
    ]);
    await Nodes.assertPlacementParent(projectId, tx);
    const { rows } = await tx.query<{ id: string; category: string | null }>(
      `SELECT c.id, c.category FROM public.containers c JOIN public.nodes n ON n.id=c.id
       WHERE n.container_id IS NOT DISTINCT FROM $1 AND NOT n.archived
         AND lower(c.name)='images' ORDER BY c.id LIMIT 1`,
      [projectId]
    );
    if (rows[0]) {
      if (rows[0].category === 'project') {
        throw new Error(
          'Images destination is itself a project; rename it before saving agent images'
        );
      }
      return { id: rows[0].id, created: false };
    }
    const id = generateId('container');
    await Nodes.ensure(id, 'container', { runner: tx });
    await tx.query(
      `UPDATE public.nodes SET container_id=$1, sort_order=(
         SELECT COALESCE(MAX(sort_order),0)+1 FROM public.nodes
         WHERE container_id IS NOT DISTINCT FROM $1 AND type='container' AND NOT archived
       ) WHERE id=$2`,
      [projectId, id]
    );
    await tx.query(`INSERT INTO public.containers (id,name,created_by) VALUES ($1,'Images',$2)`, [
      id,
      createdBy,
    ]);
    return { id, created: true };
  });
  if (result.created) {
    const container = await Containers.findById(result.id);
    if (container) emitTreeNodeCreated(snapshotFromContainer(container));
  }
  return result.id;
}
