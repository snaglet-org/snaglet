/**
 * Registry-level `id`-param test: every node-manipulating tool in scope
 * advertises a single agent-facing `id` for its primary subject, and declares
 * the `param_aliases` that map it back onto whatever internal key the handler
 * reads. Loads the real registry (mirrors ToolExecutor.test.ts) so a
 * definition.ts typo or a missed rename fails here, not just in a hand-mocked
 * unit test.
 */
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';

function schemaProperties(toolId: string): Record<string, unknown> {
  const def = toolRegistry.getDefinition(toolId);
  const props = (def?.parameters_schema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  return props ?? {};
}

/** Every param the tool accepts: advertised, plus `unlisted_params` (left out to save tokens). */
function acceptedParams(toolId: string): Record<string, unknown> {
  return { ...schemaProperties(toolId), ...toolRegistry.getDefinition(toolId)?.unlisted_params };
}

describe('id-param standardization — real registry', () => {
  beforeAll(async () => {
    await toolRegistry.load();
  });

  // toolId -> { internal key the handler reads, aliases it should accept }
  const expected: Record<string, { internalKey: string; aliases: string[] }> = {
    // docs: doc(op) advertises `id` natively (see the doc test below).
    // doc_history, convert_doc_to_container, diff_doc and duplicate_doc are ops
    // of `doc` too; their old ids resolve through toolAliases.
    // containers: container(op) advertises `id` natively on update and
    // maps the legacy container_id per op (see the container test below).
    // threads
    // thread(op) covers read/create/update/add_agents/remove_agents/delete/send (the prompt changes via update; agents join via add_agents).
    thread: { internalKey: 'thread_id', aliases: ['id'] },
    // workspace nodes: node(op) advertises `id` natively and maps the
    // old names onto it (see the node test below).
  };

  it.each(Object.entries(expected))(
    '%s: schema advertises `id`, and param_aliases maps it to the untouched internal key',
    (toolId, { internalKey, aliases }) => {
      const def = toolRegistry.getDefinition(toolId);
      expect(def).toBeDefined();

      // Agent-facing schema shows the canonical `id`.
      const props = schemaProperties(toolId);
      expect(props).toHaveProperty('id');

      // The alias table is separate from the schema (never shown to the
      // agent) and correctly points the internal key back at its aliases.
      expect(def?.param_aliases).toBeDefined();
      expect(def?.param_aliases?.[internalKey]).toEqual(aliases);
    }
  );

  it('node(op) uses `id` natively and accepts the old node-tool parameter names', () => {
    // get_node/archive_node/restore_node/move/rename are ops of `node`.
    // The subject is `id`; old callers' names map onto the node fields.
    expect(schemaProperties('node')).toHaveProperty('id');
    expect(toolRegistry.getDefinition('node')?.param_aliases).toEqual({
      id: ['node_id'],
      parent_id: ['new_parent_id'],
      parent_path: ['new_parent_path'],
      title: ['new_title'],
    });
  });

  it('doc(op) uses `id` natively and accepts the old doc-tool parameter names', () => {
    // get_doc/create_doc/edit_doc/delete_doc are ops of `doc`.
    expect(schemaProperties('doc')).toHaveProperty('id');
    expect(schemaProperties('doc')).toHaveProperty('path');
    expect(toolRegistry.getDefinition('doc')?.param_aliases).toEqual({
      id: ['doc_id'],
      path: ['doc_path'],
    });
  });

  it('canonical clone_node uses `id` natively', () => {
    // clone_node advertises `id` for its subject natively (no param_aliases
    // bridge needed) and keeps its destination `target_container_id` distinct.
    for (const toolId of ['clone_node']) {
      const props = schemaProperties(toolId);
      expect(props).toHaveProperty('id');
    }
    expect(toolRegistry.getDefinition('clone_node')?.param_aliases).toBeUndefined();
    expect(schemaProperties('clone_node')).toHaveProperty('target_container_id');
  });

  it('secondary/destination params are left qualified, never folded into `id`', () => {
    // node(op:restore)'s destination parent_id is a different node than the
    // subject being restored — must stay a distinct visible param.
    const nodeProps = schemaProperties('node');
    expect(nodeProps).toHaveProperty('parent_id');
    expect(toolRegistry.getDefinition('node')?.param_aliases?.id).toEqual(['node_id']);

    // doc(op:duplicate)'s target_container_id is the destination for the copy,
    // not the doc being duplicated.
    const duplicateProps = acceptedParams('doc');
    expect(duplicateProps).toHaveProperty('target_container_id');

    // thread delete's project_id is a scope assertion, not the subject.
    const threadDeleteProps = schemaProperties('thread');
    expect(threadDeleteProps).toHaveProperty('project_id');

    // doc_history restore's snapshot_id is a distinct required param from the
    // (optional) target doc id.
    const restoreSnapshotProps = acceptedParams('doc');
    expect(restoreSnapshotProps).toHaveProperty('snapshot_id');
  });

  it('create_* parent/destination params are untouched (not the tool subject)', () => {
    // doc(op:create) / container(op:create) place a new node under a parent and
    // thread_create scopes one to a project — the destination is never the
    // subject and keeps its qualified name.
    expect(schemaProperties('doc')).toHaveProperty('parent_id');
    expect(schemaProperties('container')).toHaveProperty('parent_id');
    expect(schemaProperties('thread')).toHaveProperty('project_id');
    expect(schemaProperties('thread')).not.toHaveProperty('container_id');
    expect(toolRegistry.getDefinition('doc')?.param_aliases?.parent_id).toBeUndefined();
    expect(toolRegistry.getDefinition('container')?.param_aliases).toBeUndefined();
  });

  it('container(op) advertises `id`/`path` (update) and hides the legacy container_id/container_path', () => {
    // container_id/container_path are op-specific legacy names (create:
    // the parent; update: the target), mapped in the tool, never in the schema.
    const props = schemaProperties('container');
    expect(props).toHaveProperty('id');
    expect(props).toHaveProperty('path');
    expect(props).not.toHaveProperty('container_id');
    expect(props).not.toHaveProperty('container_path');
  });

  it('scope/filter params on search, list, and tree tools are left alone', () => {
    for (const toolId of [
      'doc_search',
      'container_search',
      'workspace_tree',
      'workspace_list_recent',
    ]) {
      expect(toolRegistry.getDefinition(toolId)?.param_aliases).toBeUndefined();
    }
  });

  it('the folded doc tools are not standalone registry entries', () => {
    for (const toolId of ['convert_doc_to_container', 'diff_doc', 'duplicate_doc', 'doc_history']) {
      expect(toolRegistry.getDefinition(toolId)).toBeUndefined();
    }
  });
});
