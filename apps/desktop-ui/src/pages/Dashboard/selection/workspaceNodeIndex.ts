import type { LibraryTreeChild } from '@desktop/utils/api';

/** Build an id-indexed view of the nested workspace tree. */
export function indexWorkspaceNodes(nodes: LibraryTreeChild[]): Map<string, LibraryTreeChild> {
  const indexed = new Map<string, LibraryTreeChild>();
  const visit = (items: LibraryTreeChild[]): void => {
    for (const node of items) {
      indexed.set(node.id, node);
      if (node.kind === 'container') visit(node.children ?? []);
    }
  };
  visit(nodes);
  return indexed;
}
