/**
 * convert_doc_to_container — the sub-items graduation operation.
 *
 * A work item (or any doc) that grows children GRADUATES from doc to
 * container: a new container is minted in the doc's current location (same
 * parent, same name, inheriting sort_order) and the doc is moved inside it as
 * the container's overview doc. Child docs then live under the container and
 * drill-down is ordinary tree navigation — no parent_doc_id, no second
 * hierarchy competing with containers.
 *
 * Invariants:
 *   - The doc keeps its id (Docs.moveTo never changes it), so links, feedback,
 *     and embeddings survive.
 *   - The container is a NEW node with its own id.
 *   - placement_events records the doc's move automatically (Docs.moveTo).
 *   - Conservative default: the container is plain unless the caller passes
 *     `category`.
 */

import { Containers, Docs } from '@snaglet/db';
import { isContainerCategory } from '@snaglet/shared/constants';
import type { ContainerCategory } from '@snaglet/shared/constants';
import type { ToolHandler } from '@server/services/ToolService/types';
import { linkForm } from '@server/services/ToolService/lib/linkForm';
import {
  emitTreeNodeCreated,
  emitTreeNodeUpdated,
  snapshotFromContainer,
} from '@server/realtime/surfaces/tree';
import { getCurrentActor } from '@server/realtime/actorContext';

interface ConvertInputShape {
  doc_id: string;
  category?: ContainerCategory;
}

function parseInput(input: unknown): ConvertInputShape {
  if (!input || typeof input !== 'object') {
    throw new Error('convert_doc_to_container: input must be an object');
  }
  const i = input as Record<string, unknown>;
  if (typeof i.doc_id !== 'string' || i.doc_id.trim().length === 0) {
    throw new Error(
      'convert_doc_to_container: `doc_id` is required and must be a non-empty string'
    );
  }
  if (i.category !== undefined && i.category !== null && !isContainerCategory(i.category)) {
    throw new Error('convert_doc_to_container: `category` must be `project` when provided');
  }
  return {
    doc_id: i.doc_id.trim(),
    category: (i.category as ContainerCategory | undefined) || undefined,
  };
}

const handler: ToolHandler = async (input) => {
  const params = parseInput(input);

  const doc = await Docs.findById(params.doc_id);
  if (!doc) {
    throw new Error(`convert_doc_to_container: doc not found: ${params.doc_id}`);
  }
  if (doc.archived) {
    throw new Error(
      `convert_doc_to_container: doc ${params.doc_id} is archived; restore it before converting`
    );
  }

  const parentId = doc.containerId;

  // A container and the doc it graduates from share a name; enforce
  // sibling-container uniqueness the same way create_container does so we
  // never mint two containers with the same name at one level.
  const siblingContainers = await Containers.listByParent(parentId);
  const collision = siblingContainers.find(
    (c) => c.name.localeCompare(doc.title, undefined, { sensitivity: 'accent' }) === 0
  );
  if (collision) {
    throw new Error(
      `convert_doc_to_container: a container named "${doc.title}" already exists at this level (id=${collision.id})`
    );
  }

  // 1) Mint the container in the doc's current spot, inheriting its sort_order.
  const container = await Containers.create({
    name: doc.title,
    parentId,
    category: params.category ?? null,
    sortOrder: doc.sortOrder,
  });
  emitTreeNodeCreated(snapshotFromContainer(container));

  // 2) Move the doc inside as the overview doc (placement_events flows via
  // moveTo). Appended (no explicit sort_order) so it lands first in an
  // otherwise-empty container.
  const movedBy = getCurrentActor()?.actorId ?? null;
  const overview = await Docs.moveTo(doc.id, container.id, undefined, movedBy);
  if (!overview) {
    throw new Error(`convert_doc_to_container: doc vanished mid-convert: ${doc.id}`);
  }

  emitTreeNodeUpdated({
    id: overview.id,
    kind: 'doc',
    parentId: container.id,
    sortKey: String(overview.sortOrder),
    updatedAt: overview.updatedAt,
  });

  const result = {
    success: true,
    container: {
      id: container.id,
      name: container.name,
      parent_id: container.parentId,
      category: container.category,
      sort_order: container.sortOrder,
    },
    overview_doc: {
      id: overview.id,
      title: overview.title,
      container_id: overview.containerId,
      sort_order: overview.sortOrder,
    },
    links: {
      container: linkForm('container', container.id, container.name),
      doc: linkForm('doc', overview.id, overview.title),
    },
    message: `Converted doc "${overview.title}" (${overview.id}) into container ${container.id}; the doc is now its overview doc.`,
  };

  return {
    output: JSON.stringify(result, null, 2),
    rawContent: result,
  };
};

export default handler;
