// title.ts — resolve a display title for a chip-eligible node. Trims
// whitespace; falls back to a kind-specific default; never returns
// empty. Use everywhere a node title gets rendered or embedded.

import type { NodeChipData } from './payload';
import { fallbackTitleForKind } from './kinds';

export const nodeTitle = (node: NodeChipData): string => {
  const raw = (node.title?.trim() || node.name?.trim() || '') as string;
  return raw || fallbackTitleForKind(node.kind);
};
