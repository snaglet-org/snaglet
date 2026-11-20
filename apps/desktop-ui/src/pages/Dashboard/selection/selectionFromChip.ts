import { agentsApi, toolsApi, threadsApi, memoriesApi } from '@desktop/utils/api';
import { parseEntryChipId, type NodeChipData } from '@desktop/utils/nodeChip';
import { getCachedTableEntry } from '@desktop/features/database/tableNameCache';
import type { DetailSelection } from './types';
import { nextFocusRequestId } from './focusRequest';

/** Kinds with a corresponding workspace/detail pane. Other chips remain insertable links. */
export const canOpenChipInPane = (chip: NodeChipData): boolean =>
  [
    'doc',
    'thread',
    'container',
    'project',
    'image',
    'sketch',
    'agent',
    'tool',
    'message',
    'thread_summary',
    'memory',
    'file',
    'table',
    'entry',
  ].includes(chip.kind);

/** Node chips carry identity, not stale copies of whole workspace records. */
export function selectionFromChip(chip: NodeChipData): DetailSelection | Promise<DetailSelection> {
  switch (chip.kind) {
    case 'entry': {
      const ref = parseEntryChipId(chip.id);
      return ref
        ? {
            kind: 'table',
            table_id: ref.tableId,
            table: getCachedTableEntry(ref.tableId) ?? undefined,
            focusEntryId: ref.entryId,
            focusRequestId: nextFocusRequestId(),
          }
        : null;
    }
    case 'doc':
      return { kind: 'doc', doc_id: chip.id };
    case 'thread':
      return { kind: 'thread', thread_id: chip.id };
    case 'container':
    case 'project':
      return { kind: 'container', container_id: chip.id };
    case 'image':
      return { kind: 'image', image_id: chip.id };
    case 'sketch':
      return { kind: 'sketch', sketch_id: chip.id };
    case 'file':
      return {
        kind: 'file',
        node: {
          kind: 'file',
          id: chip.id,
          containerId: null,
          projectId: '',
          relativePath: chip.id,
          absolutePath: chip.id,
          name: chip.title || chip.id.split('/').pop() || chip.id,
          sizeBytes: 0,
          updatedAt: '',
        },
      };
    case 'table': {
      // A catalog id, never a workspace node id. The cached entry (when
      // known) titles the pane chrome; the pane fetches the canonical one.
      const table = getCachedTableEntry(chip.id);
      return table
        ? { kind: 'table', table_id: chip.id, table }
        : { kind: 'table', table_id: chip.id };
    }
    case 'agent':
      return agentsApi.get(chip.id).then((agent) => ({ kind: 'agent', agent }));
    case 'tool':
      return toolsApi.get(chip.id).then((tool) => ({ kind: 'tool', tool }));
    case 'message':
      return threadsApi.getMessage(chip.id).then((message) => ({
        kind: 'thread',
        thread_id: message.threadId,
        focusMessageId: message.id,
        focusRequestId: Date.now(),
      }));
    case 'thread_summary':
      return threadsApi.getSummary(chip.id).then((summary) => ({
        kind: 'thread',
        thread_id: summary.threadId,
        focusAgentId: summary.agentId ?? undefined,
        focusSummaryId: summary.id,
      }));
    case 'memory':
      // A fact about a person (member-owned) has no agent: it opens in its
      // thread, or nowhere when it has none.
      return memoriesApi.getById(chip.id).then(async (memory) =>
        memory.sourceThreadId
          ? {
              kind: 'thread',
              thread_id: memory.sourceThreadId,
              focusAgentId: memory.agentId ?? undefined,
              focusMemoryId: memory.id,
            }
          : memory.agentId
            ? { kind: 'agent', agent: await agentsApi.get(memory.agentId) }
            : null
      );
    default:
      return null;
  }
}
