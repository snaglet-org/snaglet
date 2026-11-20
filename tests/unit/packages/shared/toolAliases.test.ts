import {
  TOOL_ALIASES,
  canonicalToolName,
  isRetiredToolId,
  resolveToolId,
  toolAliasIdsFor,
  toolIdsEquivalent,
  transformToolAliasParams,
} from '@snaglet/shared/utils';

describe('tool aliases', () => {
  it('retains get_clarification as a resolve-only ask alias', () => {
    expect(resolveToolId('get_clarification').id).toBe('ask');
    expect(toolIdsEquivalent('ask', 'get_clarification')).toBe(true);
    expect(transformToolAliasParams(resolveToolId('get_clarification'), { questions: [] })).toEqual(
      { questions: [] }
    );
  });
  it('resolves a renamed id, renames params, and pins its routing discriminator', () => {
    const resolution = resolveToolId('code_search');
    expect(resolution.id).toBe('search');
    expect(
      transformToolAliasParams(resolution, {
        query: 'needle',
        mode: 'name',
        max_results: 12,
        kind: 'files',
      })
    ).toMatchObject({
      query: 'needle',
      kind: 'code',
      code_mode: 'name',
      limit: 12,
    });
  });

  it('generates capability aliases with operation pins', () => {
    const resolution = resolveToolId('google_gmail_send');
    expect(resolution.id).toBe('google_gmail');
    expect(transformToolAliasParams(resolution, { to: 'a@example.com' })).toEqual({
      to: 'a@example.com',
      operation: 'send',
    });
  });

  it('routes mutating Drive aliases through the admin capability', () => {
    const resolution = resolveToolId('google_drive_delete_file');
    expect(resolution.id).toBe('google_drive_admin');
    expect(transformToolAliasParams(resolution, { fileId: 'file-1' })).toEqual({
      fileId: 'file-1',
      operation: 'delete_file',
    });
  });

  it('compares old and canonical ids in either direction', () => {
    expect(toolIdsEquivalent('workspace_search', 'search')).toBe(true);
    expect(toolIdsEquivalent('search', 'workspace_search')).toBe(true);
    expect(toolIdsEquivalent('search', 'file_read')).toBe(false);
  });

  it('exposes reverse aliases for stored config fallback', () => {
    expect(toolAliasIdsFor('memory')).toEqual(
      expect.arrayContaining([
        'memory_save',
        'memory_store',
        'memory_search',
        'memory_recall',
        'memory_edit',
        'memory_forget',
      ])
    );
  });

  it('pins each retired memory id to exactly one op of the merged memory tool', () => {
    const expected: Record<string, string> = {
      memory_search: 'search',
      memory_recall: 'search',
      memory_save: 'create',
      memory_store: 'create',
      memory_edit: 'update',
      memory_forget: 'delete',
    };
    for (const [oldId, op] of Object.entries(expected)) {
      const resolution = resolveToolId(oldId);
      expect(resolution).toMatchObject({ id: 'memory', op, aliasedFrom: oldId });
      // The pinned op wins even if the caller tries to redirect it.
      expect(resolution.transformParams?.({ op: 'delete', content: 'x' })).toMatchObject({
        op,
        content: 'x',
      });
    }
  });

  it('pins each retired thread id and alternate name to one op of thread(op)', () => {
    const expected: Record<string, string> = {
      thread_read: 'read',
      message_context: 'read',
      thread_create: 'create',
      create_thread: 'create',
      new_thread: 'create',
      start_thread: 'create',
      thread_update: 'update',
      update_thread: 'update',
      configure_thread: 'update',
      thread_settings_update: 'update',
      thread_delete: 'delete',
    };
    for (const [oldId, op] of Object.entries(expected)) {
      const resolution = resolveToolId(oldId);
      expect(resolution).toMatchObject({ id: 'thread', op, aliasedFrom: oldId });
      expect(resolution.transformParams?.({ op: 'delete', id: 't-1' })).toMatchObject({
        op,
        id: 't-1',
      });
    }
    // The prompt changes only through thread op update: the old id is removed, not remapped.
    const setPrompt = resolveToolId('thread_system_prompt_update');
    expect(setPrompt.id).toBe('thread_system_prompt_update');
    expect(setPrompt.removed).toMatch(/thread op "update" with thread: \{system_prompt/);
    // Adding an agent is thread op add_agents: the old ids are removed, not remapped.
    for (const oldId of ['thread_add_agent', 'thread_add_participant', 'add_agent_to_thread']) {
      const removed = resolveToolId(oldId);
      expect(removed.id).toBe(oldId);
      expect(removed.op).toBeUndefined();
      expect(removed.removed).toMatch(/thread op "add_agents" with agent_ids/);
    }
    // thread_send folded into thread(op:send), pinned; get_clarification stays separate.
    const send = resolveToolId('thread_send');
    expect(send).toMatchObject({ id: 'thread', op: 'send', aliasedFrom: 'thread_send' });
    expect(send.transformParams?.({ op: 'delete', id: 't-1', content: 'x' })).toMatchObject({
      op: 'send',
      id: 't-1',
      content: 'x',
    });
    expect(resolveToolId('get_clarification')).toMatchObject({
      id: 'ask',
      aliasedFrom: 'get_clarification',
    });
  });

  it('message_context keeps its window mode pinned on thread read', () => {
    const resolution = resolveToolId('message_context');
    expect(
      transformToolAliasParams(resolution, { message_id: 'm-1', mode: 'thread', op: 'create' })
    ).toEqual({ message_id: 'm-1', mode: 'message_context', op: 'read' });
  });

  it('pins every old node tool id to its node(op) op', () => {
    const expected: Record<string, string> = {
      get_node: 'get',
      workspace_get_node: 'get',
      verify_ids: 'get',
      workspace_tree: 'tree',
      workspace_project_tree: 'tree',
      move: 'move',
      workspace_move: 'move',
      move_container: 'move',
      container_move: 'move',
      rename: 'rename',
      workspace_rename: 'rename',
      archive_node: 'archive',
      workspace_archive_node: 'archive',
      archive_container: 'archive',
      container_archive: 'archive',
      restore_node: 'restore',
      workspace_restore_node: 'restore',
    };
    for (const [oldId, op] of Object.entries(expected)) {
      expect(resolveToolId(oldId)).toMatchObject({ id: 'node', op, aliasedFrom: oldId });
    }
  });

  it('pins every old doc tool id to its doc(op) op and carries doc_id/doc_path over', () => {
    const expected: Record<string, string> = {
      get_doc: 'get',
      workspace_get_doc: 'get',
      create_doc: 'create',
      workspace_create_doc: 'create',
      edit_doc: 'update',
      workspace_edit_doc: 'update',
      delete_doc: 'delete',
      workspace_delete_doc: 'delete',
    };
    for (const [oldId, op] of Object.entries(expected)) {
      expect(resolveToolId(oldId)).toMatchObject({ id: 'doc', op, aliasedFrom: oldId });
    }
    const t = (id: string, params: Record<string, unknown>) =>
      transformToolAliasParams(resolveToolId(id), params);
    expect(t('edit_doc', { doc_id: 'd', op: 'delete' })).toMatchObject({ op: 'update', id: 'd' });
    expect(t('get_doc', { doc_path: '/a' })).toMatchObject({ op: 'get', path: '/a' });
    // create keeps its container_id; the create handler resolves it.
    expect(t('create_doc', { container_id: 'c' })).toEqual({ op: 'create', container_id: 'c' });
    expect(resolveToolId('restore_snapshot')).toMatchObject({ id: 'doc', op: 'restore' });
  });

  it('pins every old container tool id to its container(op) op', () => {
    const expected: Record<string, string> = {
      create_container: 'create',
      workspace_create_container: 'create',
      update_container: 'update',
      workspace_update_container: 'update',
    };
    for (const [oldId, op] of Object.entries(expected)) {
      expect(resolveToolId(oldId)).toMatchObject({ id: 'container', op, aliasedFrom: oldId });
    }
    const t = (id: string, params: Record<string, unknown>) =>
      transformToolAliasParams(resolveToolId(id), params);
    // container_id passes through untouched; container(op) maps it per op.
    expect(t('update_container', { container_id: 'c', op: 'create' })).toEqual({
      op: 'update',
      container_id: 'c',
    });
    expect(t('create_container', { container_id: 'p' })).toEqual({
      op: 'create',
      container_id: 'p',
    });
  });

  it('carries old node-tool parameter names and kind/scope pins over', () => {
    const t = (id: string, params: Record<string, unknown>) =>
      transformToolAliasParams(resolveToolId(id), params);
    expect(t('move', { node_id: 'd', new_parent_id: 'c', new_parent_path: '/x' })).toMatchObject({
      op: 'move',
      id: 'd',
      parent_id: 'c',
      parent_path: '/x',
    });
    expect(t('move_container', { id: 'c1', kind: 'doc' })).toMatchObject({
      op: 'move',
      kind: 'container',
    });
    expect(t('rename', { id: 'd', new_title: 'T' })).toMatchObject({ op: 'rename', title: 'T' });
    expect(t('restore_node', { node_id: 'd', container_id: null })).toMatchObject({
      op: 'restore',
      id: 'd',
    });
    expect(t('restore_node', { node_id: 'd', container_id: 'c' })).toMatchObject({
      parent_id: 'c',
    });
    expect(t('workspace_tree', { container_id: 'c' })).toMatchObject({ op: 'tree', id: 'c' });
    expect(t('workspace_project_tree', { scope: 'workspace' })).toMatchObject({
      op: 'tree',
      scope: 'current_project',
    });
    expect(t('archive_container', { id: 'c', kind: 'node' })).toMatchObject({
      op: 'archive',
      kind: 'container',
    });
    // A caller cannot redirect an old id to another op.
    expect(t('get_node', { id: 'd', op: 'archive' })).toMatchObject({ op: 'get' });
  });

  it('marks intentional removals with an actionable tombstone', () => {
    const resolution = resolveToolId('sandbox_run');
    expect(resolution.removed).toContain('guarded shell tool');
  });

  it('table_list pins table op read, passing its old origin field through', () => {
    const resolution = resolveToolId('table_list');
    expect(resolution).toMatchObject({ id: 'table', op: 'read', aliasedFrom: 'table_list' });
    expect(transformToolAliasParams(resolution, { origin: 'custom', op: 'delete' })).toEqual({
      origin: 'custom',
      op: 'read',
    });
    expect(toolIdsEquivalent('table_list', 'table')).toBe(true);
  });

  it.each([
    ['table_read', 'read'],
    ['table_write', 'write'],
    ['table_schema', 'schema'],
    ['table_delete', 'delete'],
    ['get_user_pane_layout', 'layout'],
    ['navigate_user_pane', 'navigate'],
  ])('%s pins op %s on its merged tool', (oldId, op) => {
    const resolution = resolveToolId(oldId);
    expect(resolution.op).toBe(op);
    expect(resolution.id).toBe(oldId.startsWith('table_') ? 'table' : 'pane');
    expect(transformToolAliasParams(resolution, { op: 'smuggled' })).toMatchObject({ op });
  });

  it.each([
    ['table_create', 'table {op: "schema", table, fields}'],
    ['table_rename', 'table {op: "schema", ops: [{op: "rename_table", name}]}'],
    ['table_field_create', 'table {op: "schema", ops: [{op: "add_field", field}]}'],
    ['table_field_update', 'table {op: "schema", ops: [{op: "update_field", name, set}]}'],
    ['table_entries_list', 'table {op: "read", sql}'],
    ['table_entry_get', 'table {op: "read", table, ids}'],
    ['table_entry_create', 'table {op: "write", table, insert}'],
    ['table_entry_update', 'table {op: "write", table, update}'],
  ])('retires %s with guidance toward %s', (oldId, guidance) => {
    const resolution = resolveToolId(oldId);
    expect(resolution.id).toBe(oldId);
    expect(resolution.removed).toMatch(/^This tool was intentionally removed/);
    expect(resolution.removed).toContain(guidance);
    expect(toolIdsEquivalent(oldId, 'table')).toBe(false);
  });

  it.each([
    ['database_create', 'table {op: "write", table, insert}'],
    ['database_update', 'table {op: "write", table, update: [{id, rev, values}]}'],
    ['database_delete', 'table {op: "delete", table, ids}'],
    ['database_describe', 'table {op: "read", table}'],
    ['say', 'guarded shell command'],
    ['url_parse', 'Parse the URL natively'],
    ['eslint_check', 'guarded shell tool'],
    ['ts_typecheck', 'guarded shell tool'],
  ])('retires %s (2026-10) as a tombstone pointing at %s', (oldId, guidance) => {
    const resolution = resolveToolId(oldId);
    // A tombstone keeps its own id, so a stored rule naming it never widens to
    // the replacement tool.
    expect(resolution.id).toBe(oldId);
    expect(resolution.removed).toMatch(/^This tool was intentionally removed/);
    expect(resolution.removed).toContain(guidance);
  });

  it('never resolves an id through Object.prototype', () => {
    expect(resolveToolId('constructor')).toEqual({ id: 'constructor' });
    expect(isRetiredToolId('toString')).toBe(false);
  });
});

describe('canonical display (aliases stay resolve-only)', () => {
  it('marks old ids and tombstones retired, never canonical or unknown ids', () => {
    expect(isRetiredToolId('exec_command')).toBe(true);
    expect(isRetiredToolId('sketch_create')).toBe(true);
    expect(isRetiredToolId('sandbox_run')).toBe(true);
    expect(isRetiredToolId('shell')).toBe(false);
    expect(isRetiredToolId('mcp__notion__search')).toBe(false);
  });

  it('keeps an old id that still has a live definition of its own', () => {
    expect(isRetiredToolId('exec_command', new Set(['exec_command']))).toBe(false);
    expect(canonicalToolName('exec_command', new Set(['exec_command']))).toEqual({
      id: 'exec_command',
      aliasedFrom: null,
    });
  });

  it('shows an old id as its canonical tool, keeping the old name for a hint', () => {
    expect(canonicalToolName('exec_command')).toEqual({ id: 'shell', aliasedFrom: 'exec_command' });
    expect(canonicalToolName('workspace_search')).toEqual({
      id: 'search',
      aliasedFrom: 'workspace_search',
    });
  });

  it('shows canonical ids and tombstones as themselves', () => {
    expect(canonicalToolName('shell')).toEqual({ id: 'shell', aliasedFrom: null });
    expect(canonicalToolName('sandbox_run')).toEqual({ id: 'sandbox_run', aliasedFrom: null });
  });
});

describe('pins: every routing value an old id forces is recorded', () => {
  // Output-format compat flags are forced too, but they change how a call
  // reports, not what it may do, so they are deliberately not pins.
  const COMPAT_KEYS = new Set(['legacy_output', 'compat']);
  const PROBE = '__caller_value__';

  /** Keys the transform sets to the same value whatever the caller sends. */
  const forcedValues = (id: string): Record<string, unknown> => {
    const resolution = resolveToolId(id);
    const base = transformToolAliasParams(resolution, {});
    return Object.fromEntries(
      Object.entries(base).filter(
        ([key, value]) =>
          value !== undefined &&
          transformToolAliasParams(resolution, { [key]: PROBE })[key] === value
      )
    );
  };

  it.each(
    Object.keys(TOOL_ALIASES).filter((id) => !TOOL_ALIASES[id]!.removed && !TOOL_ALIASES[id]!.ops)
  )('%s records exactly the routing values it forces', (id) => {
    const forced = forcedValues(id);
    const routing = Object.fromEntries(
      Object.entries(forced).filter(([key]) => !COMPAT_KEYS.has(key))
    );
    expect(resolveToolId(id).pins ?? {}).toEqual(routing);
  });

  it.each([
    ['git_status', { subcommand: 'status' }],
    ['git_push', { subcommand: 'push' }],
    ['google_gmail_send', { operation: 'send' }],
    ['google_drive_share_file', { operation: 'share_file' }],
    ['send_imessage', { operation: 'send' }],
    ['snapshot_doc', { op: 'snapshot' }],
    ['workspace_search', { kind: 'workspace' }],
    ['workspace_list_archived', { kind: 'workspace', archived_only: true }],
    ['workspace_resolve_path', { domain: 'workspace' }],
    ['get_local_context', { mode: 'local' }],
    ['list_tools', { op: 'search', mode: 'list' }],
    ['exec_command', { op: 'run' }],
    ['shell_exec', { op: 'run' }],
    ['move_container', { op: 'move', kind: 'container' }],
    ['workspace_archive_node', { op: 'archive', kind: 'node' }],
    ['workspace_project_tree', { op: 'tree', scope: 'current_project' }],
    ['message_context', { op: 'read', mode: 'message_context' }],
    ['update_identity', { op: 'update', scope: 'self' }],
    ['self_inspect', { op: 'get', view: 'runtime_self' }],
    ['get_providers', { op: 'list', operation: 'providers' }],
    ['view_image', { op: 'read', mode: 'image' }],
    ['find_files', { op: 'list', mode: 'find' }],
  ])('%s pins %j', (id, pins) => {
    expect(resolveToolId(id).pins).toEqual(pins);
  });

  it('compat flags and pin-less aliases carry no pins', () => {
    expect(resolveToolId('date_time').pins).toBeUndefined();
    expect(transformToolAliasParams(resolveToolId('date_time'), {})).toEqual({
      compat: 'date_time',
    });
    for (const id of ['mcp_server', 'workspace_bulk_export', 'database_create_view']) {
      expect(resolveToolId(id).pins).toBeUndefined();
    }
  });

  it('records op in pins wherever an op is pinned', () => {
    for (const id of Object.keys(TOOL_ALIASES)) {
      const resolution = resolveToolId(id);
      if (resolution.op) expect(resolution.pins?.op).toBe(resolution.op);
    }
  });
});

describe('extended doc aliases', () => {
  it.each([
    ['duplicate_doc', 'duplicate'],
    ['workspace_duplicate_doc', 'duplicate'],
    ['diff_doc', 'diff'],
    ['workspace_diff_doc', 'diff'],
    ['convert_doc_to_container', 'convert-to-container'],
    ['workspace_convert_doc_to_container', 'convert-to-container'],
    ['snapshot_doc', 'snapshot'],
    ['workspace_snapshot_doc', 'snapshot'],
    ['list_snapshots', 'list-snapshots'],
    ['workspace_list_snapshots', 'list-snapshots'],
    ['restore_snapshot', 'restore'],
    ['workspace_restore_snapshot', 'restore'],
    ['delete_snapshot', 'delete-snapshot'],
    ['workspace_delete_snapshot', 'delete-snapshot'],
  ])('%s pins only its canonical op', (id, op) => {
    const resolved = resolveToolId(id);
    expect(resolved).toMatchObject({ id: 'doc', op, pins: { op } });
    expect(transformToolAliasParams(resolved, { op: 'delete', operation: 'delete' })).toMatchObject(
      { op }
    );
  });
  it.each([
    ['snapshot', 'snapshot'],
    ['list', 'list-snapshots'],
    ['restore', 'restore'],
    ['delete', 'delete-snapshot'],
  ])('maps doc_history operation %s without trusting op', (operation, op) => {
    const resolved = resolveToolId('doc_history');
    expect(resolved.ops).toEqual(['snapshot', 'list-snapshots', 'restore', 'delete-snapshot']);
    expect(transformToolAliasParams(resolved, { operation, op: 'delete', doc_path: '/a' })).toEqual(
      { op, doc_path: '/a', path: '/a' }
    );
  });
  it.each([undefined, '', 'get', 'constructor', '__proto__'])(
    'fails closed on history operation %s',
    (operation) => {
      expect(
        transformToolAliasParams(resolveToolId('doc_history'), { operation, op: 'delete' }).op
      ).toBe('__invalid_doc_history_operation__');
    }
  );
  it('preserves duplicate source aliases', () => {
    expect(
      transformToolAliasParams(resolveToolId('workspace_duplicate_doc'), {
        source_id: 'd',
        source_path: '/a',
      })
    ).toMatchObject({ id: 'd', path: '/a', op: 'duplicate' });
  });
});
