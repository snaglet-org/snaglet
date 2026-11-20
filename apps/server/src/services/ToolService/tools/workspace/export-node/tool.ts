import { readTrimmedString } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { getCurrentActor } from '@server/realtime/actorContext';
import { runExport, type ExportKind } from '@server/services/ExportService';

/** Author-facing kinds. `own_memories` maps onto the service's agent kind. */
const KIND_MAP: Record<string, ExportKind> = {
  doc: 'doc',
  thread: 'thread',
  image: 'image',
  own_memories: 'agent_memories',
};

const handler: ToolHandler = async (input, _settings, context) => {
  const requested = readTrimmedString(input.kind);
  const kind = KIND_MAP[requested];
  if (!kind) {
    throw new Error(`kind must be one of: ${Object.keys(KIND_MAP).join(', ')}`);
  }

  const destDir = readTrimmedString(input.dest_dir);
  if (!destDir) throw new Error('dest_dir is required — pass an existing folder to write into');

  const actor = getCurrentActor();

  let id: string;
  let allowedAgentId: string | null | undefined;

  if (kind === 'agent_memories') {
    // The only source of the agent id is the calling context. There is no
    // parameter to override it, and an external MCP caller has no agent row
    // at all — the same reason memory_recall is not projected externally.
    const callerAgentId = context?.agentId;
    if (actor?.actorKind === 'external' || !callerAgentId) {
      throw new Error(
        'own_memories can only be exported by an agent, and only its own. ' +
          'There is no way to name another agent here.'
      );
    }
    id = callerAgentId;
    allowedAgentId = callerAgentId;
    // A caller that passed an id anyway is trying to do something this tool
    // does not do; say so rather than silently ignoring it.
    const strayId = readTrimmedString(input.id);
    if (strayId && strayId !== callerAgentId) {
      throw new Error('own_memories exports your own memories; it does not take an agent id.');
    }
  } else {
    id = readTrimmedString(input.id);
    if (!id) throw new Error('id is required for doc, thread, and image exports');
  }

  const rawLimit = input.message_limit;
  const messageLimit =
    rawLimit === undefined || rawLimit === null ? undefined : Number(rawLimit) || undefined;
  if (messageLimit !== undefined && (!Number.isInteger(messageLimit) || messageLimit <= 0)) {
    throw new Error('message_limit must be a positive integer');
  }

  const { result } = await runExport({
    kind,
    id,
    destDir,
    fileName: readTrimmedString(input.file_name) || undefined,
    // Deliberately absent: `overwrite`. ExportService only honors it for a
    // human actor anyway, so passing it through would be theater — an agent
    // export is always no-clobber.
    options: { messageLimit },
    allowedAgentId,
  });

  return JSON.stringify({
    success: true,
    kind: requested,
    id: result.id,
    // The path is authoritative: a name collision produces a " (2)" suffix,
    // so the file the agent reports must be the one actually written, not the
    // one it asked for.
    path: result.path,
    file_name: result.fileName,
    bytes: result.bytes,
  });
};

export default handler;
