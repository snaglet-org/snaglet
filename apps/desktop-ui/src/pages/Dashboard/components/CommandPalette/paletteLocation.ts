import { paletteHitContext, type LibraryTreeChild } from '@desktop/utils/api';
import type { PaletteResultNode } from './paletteResultMappers';

/** A folder or project's name and parent: enough to spell a result's path. */
export interface ContainerPlace {
  name: string;
  parentId: string | null;
}

/** Every container in a flattened workspace tree, by id. */
export function containerPlaces(nodes: LibraryTreeChild[]): Map<string, ContainerPlace> {
  return new Map(
    nodes.flatMap((node) =>
      node.kind === 'container' ? [[node.id, { name: node.name, parentId: node.parentId }]] : []
    )
  );
}

/**
 * The folder path above `parentId`, top first (`Onboarding / Features`), or
 * `Workspace` at the top level, as Home names it. Null when a folder on the
 * way up is not in the loaded tree (not loaded yet, or archived).
 */
function containerPath(
  parentId: string | null,
  containers: ReadonlyMap<string, ContainerPlace>
): string | null {
  if (parentId === null) return 'Workspace';
  const names: string[] = [];
  const seen = new Set<string>();
  for (let id: string | null = parentId; id !== null; ) {
    const place = containers.get(id);
    if (!place || seen.has(id)) return null;
    seen.add(id);
    names.unshift(place.name);
    id = place.parentId;
  }
  return names.join(' / ');
}

/**
 * Where a palette result lives: the folder or project path of a container,
 * doc, image or thread; the thread a message or summary belongs to; and for a
 * table, whether it is the user's own or built in. Null when unknown or when
 * the kind has no place.
 */
export function resultLocation(
  node: PaletteResultNode,
  containers: ReadonlyMap<string, ContainerPlace>
): string | null {
  switch (node.kind) {
    case 'container':
      return containerPath(node.parentId, containers);
    case 'doc':
    case 'image':
      return containerPath(node.containerId, containers);
    case 'thread':
      return containerPath(node.projectId, containers);
    case 'message':
    case 'thread_summary': {
      const title = node.payload.threadTitle;
      return typeof title === 'string' && title.trim() ? title.trim() : 'Untitled thread';
    }
    case 'table':
      return paletteHitContext({ kind: 'table', payload: node.payload });
    default:
      return null;
  }
}
