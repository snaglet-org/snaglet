import { TOOL_ALIASES, TOOL_OP_PARAM } from '@snaglet/shared/utils';
import {
  listToolFolders,
  loadToolDefinition,
} from '@server/services/ToolService/scripts/lib/tool-metadata';
import type { ToolDefinition } from '@server/services/ToolService/types';

const DELETE_OR_REMOVE_ACTION = /(?:^|_)(?:delete|remove)(?:_|$)/;

/**
 * Delete/remove ops that are deliberately not confirm-gated. memory(op:delete)
 * (alias memory_forget) is an agent pruning its own memory, never destructive.
 * subagent(op:remove) removes only a helper the agent itself started, which
 * Snaglet also does on its own once the helper's report is read.
 * thread(op:remove_agents) takes a specialist back out of the caller's own
 * thread once its piece is done (deletes nothing; the agent can be added
 * again). It replaced update's remove_agent_ids, which was never gated either;
 * a deny rule on thread update still covers it (toolOpRules).
 */
const UNGATED_OPS = new Set([
  'memory(op:delete)',
  'subagent(op:remove)',
  'thread(op:remove_agents)',
]);

/**
 * Alias ids whose op is not confirm-gated: doc_history (operation:delete) is
 * not destructive, so doc(op:delete-snapshot) stays ungated.
 */
const UNGATED_ALIAS_IDS = new Set(['delete_snapshot', 'workspace_delete_snapshot']);

async function loadDefinitions(): Promise<ToolDefinition[]> {
  const loaded = await Promise.all(listToolFolders().map(loadToolDefinition));
  return loaded.map(({ definition }) => definition);
}

function opEnum(definition: ToolDefinition): string[] {
  const properties = definition.parameters_schema.properties as
    | Record<string, { enum?: unknown }>
    | undefined;
  const values = properties?.[TOOL_OP_PARAM]?.enum;
  return Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string') : [];
}

describe('destructive flags — delete/remove builtin audit', () => {
  it('flags every delete/remove action discovered in the builtin registry', async () => {
    const deleteOrRemoveTools = (await loadDefinitions()).filter(({ id }) =>
      DELETE_OR_REMOVE_ACTION.test(id)
    );

    // No standalone delete tool remains; merged deletes (e.g. table{delete})
    // are covered by the destructiveOps audit below.
    expect(deleteOrRemoveTools.map(({ id }) => id).sort()).toEqual([]);
    expect(deleteOrRemoveTools.filter(({ destructive }) => destructive !== true)).toEqual([]);
  });

  it('lists every delete/remove op of a merged tool(op) in destructiveOps', async () => {
    const unflagged = (await loadDefinitions()).flatMap((definition) => {
      const flagged = new Set(definition.destructiveOps ?? []);
      return opEnum(definition)
        .filter((op) => DELETE_OR_REMOVE_ACTION.test(op) && !flagged.has(op))
        .map((op) => `${definition.id}(op:${op})`)
        .filter((key) => !UNGATED_OPS.has(key));
    });

    expect(unflagged).toEqual([]);
  });

  it('keeps an old delete/remove id destructive through its op-pinned alias', async () => {
    const byId = new Map((await loadDefinitions()).map((d) => [d.id, d]));
    const oldIds = Object.entries(TOOL_ALIASES).filter(
      ([oldId, alias]) =>
        DELETE_OR_REMOVE_ACTION.test(oldId) &&
        alias.op &&
        !alias.removed &&
        !UNGATED_ALIAS_IDS.has(oldId)
    );

    expect(oldIds.map(([oldId]) => oldId)).toContain('thread_delete');
    for (const [oldId, alias] of oldIds) {
      const target = byId.get(alias.id);
      expect({ oldId, guarded: target?.destructiveOps?.includes(alias.op!) ?? false }).toEqual({
        oldId,
        guarded: true,
      });
    }
  });
});
