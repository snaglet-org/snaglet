/**
 * Maps a JSON-parsed `PANE_ITEM_MIME` payload (a serialized `DetailSelection`)
 * to the id HandlerEditor inserts when a sidebar node is dropped on the code
 * editor. Takes `unknown` and duck-types, since the value only ever comes
 * from `JSON.parse` on a DataTransfer string.
 *
 * `readChipDragData` (utils/nodeChip/payload.ts) already covers chip-eligible
 * workspace nodes; this adds `agent`, `tool`, `hook` and `file`. See
 * resolveDropInsertText.ts for how the two combine.
 */

import { isRecord } from '@snaglet/shared/utils';

export interface ResolvedSelectionId {
  id: string;
  /** Best-effort human label — not currently used for insertion (the
   *  literal we insert is always just the id), kept for callers that want
   *  to show what was dropped. */
  label: string;
}

export function resolveDetailSelectionId(raw: unknown): ResolvedSelectionId | null {
  if (!isRecord(raw) || typeof raw.kind !== 'string') return null;

  switch (raw.kind) {
    case 'doc':
      return typeof raw.doc_id === 'string' ? { id: raw.doc_id, label: 'doc' } : null;
    case 'thread':
      return typeof raw.thread_id === 'string' ? { id: raw.thread_id, label: 'thread' } : null;
    case 'container':
      return typeof raw.container_id === 'string'
        ? { id: raw.container_id, label: 'container' }
        : null;
    case 'image': {
      if (typeof raw.image_id !== 'string') return null;
      const name = isRecord(raw.node) ? raw.node.name : undefined;
      return {
        id: raw.image_id,
        label: typeof name === 'string' && name ? name : 'image',
      };
    }
    case 'agent': {
      if (!isRecord(raw.agent) || typeof raw.agent.id !== 'string') return null;
      const name = raw.agent.name;
      return { id: raw.agent.id, label: typeof name === 'string' && name ? name : 'agent' };
    }
    case 'tool': {
      if (!isRecord(raw.tool) || typeof raw.tool.id !== 'string') return null;
      const name = raw.tool.name;
      return { id: raw.tool.id, label: typeof name === 'string' && name ? name : 'tool' };
    }
    case 'hook': {
      // HookWorkspaceInfo has no separate `id` field — the folder name
      // (`hookName`) IS the hook's identity (see HookWorkspaceService's doc
      // comment, and this repo's scaffold.ts mirroring it).
      if (!isRecord(raw.hook) || typeof raw.hook.hookName !== 'string') return null;
      return { id: raw.hook.hookName, label: raw.hook.hookName };
    }
    case 'file': {
      if (!isRecord(raw.node) || typeof raw.node.id !== 'string') return null;
      const name = raw.node.name;
      return { id: raw.node.id, label: typeof name === 'string' && name ? name : 'file' };
    }
    default:
      return null;
  }
}
