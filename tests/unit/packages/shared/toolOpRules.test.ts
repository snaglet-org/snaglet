import {
  allowRuleCoversCall,
  describeAllowScope,
  evaluateOpAccess,
  formatAllowScopes,
  isPlainNameAlias,
  isOpScopedEntry,
  readToolOp,
  ruleNamesTool,
  scopeRule,
  type ResolvedToolId,
} from '@snaglet/shared/utils';

// A stand-in alias table for a merged `memory(op)` tool, so these tests do not
// depend on which slices have landed real op aliases.
const OP_ALIASES: Record<string, ResolvedToolId> = {
  memory_save: { id: 'memory', aliasedFrom: 'memory_save', op: 'create' },
  memory_forget: { id: 'memory', aliasedFrom: 'memory_forget', op: 'delete' },
  memory_search: { id: 'memory', aliasedFrom: 'memory_search', op: 'search' },
  memory_recall: { id: 'memory', aliasedFrom: 'memory_recall' }, // pin-less alias
};
const resolve = (id: string): ResolvedToolId => OP_ALIASES[id] ?? { id };
const opts = { resolve };

const allow = (...allowList: string[]) => ({ mode: 'allow_list', allowList, denyList: [] });
const deny = (...denyList: string[]) => ({ mode: 'deny_list', allowList: [], denyList });

describe('scopeRule', () => {
  it('scopes an op-pinned old id to its op on the canonical tool', () => {
    expect(scopeRule('memory_forget', opts)).toMatchObject({ toolId: 'memory', op: 'delete' });
  });
  it('keeps canonical ids and pin-less aliases tool-wide', () => {
    expect(scopeRule('memory', opts).op).toBeNull();
    expect(scopeRule('memory_recall', opts)).toMatchObject({ toolId: 'memory', op: null });
  });
  it('keeps a live catalog id exact during rollout', () => {
    const scoped = scopeRule('memory_save', { resolve, activeToolIds: new Set(['memory_save']) });
    expect(scoped).toMatchObject({ toolId: 'memory_save', op: null });
  });
  it('preserves a guard specifier', () => {
    expect(scopeRule('memory_save(x)', opts).specifier).toBe('x');
  });
});

describe('evaluateOpAccess — no silent widening', () => {
  it('allow-listing one old id allows only its op', () => {
    expect(evaluateOpAccess(allow('memory_save'), 'memory', 'create', opts).decision).toBe('allow');
    const verdict = evaluateOpAccess(allow('memory_save'), 'memory', 'delete', opts);
    expect(verdict.decision).toBe('ask');
    expect(verdict.decision !== 'allow' && verdict.reason).toContain('Allowed ops: create');
  });
  it('allow-listing several old ids unions their ops', () => {
    const access = allow('memory_save', 'memory_search');
    expect(evaluateOpAccess(access, 'memory', 'search', opts).decision).toBe('allow');
    expect(evaluateOpAccess(access, 'memory', 'delete', opts).decision).toBe('ask');
  });
  it('a canonical or pin-less entry allows every op', () => {
    expect(evaluateOpAccess(allow('memory'), 'memory', 'delete', opts).decision).toBe('allow');
    expect(evaluateOpAccess(allow('memory_recall'), 'memory', 'delete', opts).decision).toBe(
      'allow'
    );
  });
  it('a call with no op is not covered by op-scoped allows', () => {
    expect(evaluateOpAccess(allow('memory_save'), 'memory', null, opts).decision).toBe('ask');
  });
});

describe('evaluateOpAccess — no silent narrowing', () => {
  it('denying one old id blocks only its op', () => {
    const verdict = evaluateOpAccess(deny('memory_forget'), 'memory', 'delete', opts);
    expect(verdict.decision).toBe('deny');
    expect(verdict.decision !== 'allow' && verdict.reason).toContain('op `delete`');
    expect(evaluateOpAccess(deny('memory_forget'), 'memory', 'create', opts).decision).toBe(
      'allow'
    );
  });
  it('an op-scoped deny wins over a tool-wide allow', () => {
    const access = { mode: 'allow_list', allowList: ['memory'], denyList: ['memory_forget'] };
    expect(evaluateOpAccess(access, 'memory', 'delete', opts).decision).toBe('deny');
    expect(evaluateOpAccess(access, 'memory', 'search', opts).decision).toBe('allow');
  });
});

describe('evaluateOpAccess — inert by default', () => {
  it('mode all applies only the deny list', () => {
    const access = { mode: 'all', allowList: ['memory_save'], denyList: ['memory_forget'] };
    expect(evaluateOpAccess(access, 'memory', 'delete', opts).decision).toBe('deny');
    // The allow list is not read in mode all: a scoped allow narrows nothing.
    expect(evaluateOpAccess(access, 'memory', 'search', opts).decision).toBe('allow');
    expect(evaluateOpAccess({ ...access, denyList: [] }, 'memory', 'delete', opts).decision).toBe(
      'allow'
    );
  });
  it('rules for other tools do not affect this one', () => {
    expect(evaluateOpAccess(allow('memory_save'), 'file', 'read', opts).decision).toBe('allow');
  });
});

describe('readToolOp', () => {
  it('reads a trimmed op string', () => {
    expect(readToolOp({ op: ' create ' })).toBe('create');
    expect(readToolOp({})).toBeNull();
    expect(readToolOp({ op: 3 })).toBeNull();
  });
});

describe('evaluateOpAccess — specifier-scoped old ids', () => {
  it('a specifier on an op-scoped deny does not block the whole op', () => {
    const resolve = (id: string) => (id === 'old_run' ? { id: 'merged', op: 'run' } : { id });
    const verdict = evaluateOpAccess(
      { mode: 'deny_list', allowList: [], denyList: ['old_run(rm:*)'] },
      'merged',
      'run',
      { resolve }
    );
    expect(verdict.decision).toBe('allow');
  });
});

// Old ids that pin params other than `op` (real alias table): an allow rule
// covers only the calls the old id itself could make; a deny rule stays as
// broad as it was (the op it pins, else the whole tool).
describe('param pins — narrow allow, broad deny (real alias table)', () => {
  const call = (params: Record<string, unknown>) => ({ callParams: params });

  it('scopeRule carries every pin, op included', () => {
    expect(scopeRule('git_status')).toMatchObject({ toolId: 'git', op: null });
    expect(scopeRule('git_status').pins).toEqual({ subcommand: 'status' });
    expect(scopeRule('move_container').pins).toEqual({ op: 'move', kind: 'container' });
    expect(scopeRule('git').pins).toEqual({});
  });

  it('a live id keeps its own meaning: no pins', () => {
    expect(scopeRule('git_status', { activeToolIds: new Set(['git_status']) })).toMatchObject({
      toolId: 'git_status',
      pins: {},
    });
  });

  it('allowRuleCoversCall needs every pin, and fails closed on a missing one', () => {
    const rule = scopeRule('update_identity');
    expect(allowRuleCoversCall(rule, 'update', { op: 'update', scope: 'self' })).toBe(true);
    expect(allowRuleCoversCall(rule, 'update', { op: 'update', scope: 'agent' })).toBe(false);
    expect(allowRuleCoversCall(rule, 'update', { op: 'update' })).toBe(false);
    expect(allowRuleCoversCall(rule, 'update')).toBe(false);
    expect(allowRuleCoversCall(rule, 'get', { scope: 'self' })).toBe(false);
    expect(allowRuleCoversCall(scopeRule('agent'), 'delete', {})).toBe(true);
  });

  it('allow git_status covers status only', () => {
    const access = allow('git_status');
    expect(evaluateOpAccess(access, 'git', null, call({ subcommand: 'status' })).decision).toBe(
      'allow'
    );
    const verdict = evaluateOpAccess(access, 'git', null, call({ subcommand: 'push' }));
    expect(verdict.decision).toBe('ask');
    expect(verdict.decision !== 'allow' && verdict.reason).toBe(
      'Not covered by an allow rule: subcommand `push` of `git` is not enabled for you. Allowed subcommand: status.'
    );
    expect(evaluateOpAccess(access, 'git', null).decision).toBe('ask');
  });

  it('allow google_gmail_send covers send only', () => {
    const access = allow('google_gmail_send', 'google_gmail_search');
    expect(
      evaluateOpAccess(access, 'google_gmail', null, call({ operation: 'send' })).decision
    ).toBe('allow');
    expect(
      evaluateOpAccess(access, 'google_gmail', null, call({ operation: 'search' })).decision
    ).toBe('allow');
    for (const operation of ['get_message', 'list', 'delete']) {
      expect(evaluateOpAccess(access, 'google_gmail', null, call({ operation })).decision).toBe(
        'ask'
      );
    }
  });

  it('a canonical allow next to pinned ones still covers everything', () => {
    const access = allow('git_status', 'git');
    expect(evaluateOpAccess(access, 'git', null, call({ subcommand: 'push' })).decision).toBe(
      'allow'
    );
  });

  it('deny git_push (no op pinned) blocks the whole tool', () => {
    for (const subcommand of ['push', 'status']) {
      const verdict = evaluateOpAccess(deny('git_push'), 'git', null, call({ subcommand }));
      expect(verdict.decision).toBe('deny');
      expect(verdict.decision !== 'allow' && verdict.rule).toBe('git_push');
    }
  });

  it('deny update_identity blocks op update for every scope, nothing else', () => {
    for (const scope of ['self', 'agent', undefined]) {
      expect(
        evaluateOpAccess(deny('update_identity'), 'agent', 'update', call({ scope })).decision
      ).toBe('deny');
    }
    expect(evaluateOpAccess(deny('update_identity'), 'agent', 'get', call({})).decision).toBe(
      'allow'
    );
  });

  it('a bare canonical deny blocks every call; a specifier deny is left to the guard', () => {
    expect(evaluateOpAccess(deny('google_gmail'), 'google_gmail', null).decision).toBe('deny');
    expect(evaluateOpAccess(deny('git(git push:*)'), 'git', null).decision).toBe('allow');
  });

  it('describes scopes the way the editor and the ask reason show them', () => {
    expect(describeAllowScope(scopeRule('exec_command'))).toEqual({ key: 'ops', label: 'run' });
    expect(describeAllowScope(scopeRule('move_container'))).toEqual({
      key: 'ops',
      label: 'move (container only)',
    });
    expect(describeAllowScope(scopeRule('git_status'))).toEqual({
      key: 'subcommand',
      label: 'status',
    });
    expect(describeAllowScope(scopeRule('workspace_list_archived'))).toEqual({
      key: 'kind',
      label: 'workspace (archived_only)',
    });
    expect(describeAllowScope(scopeRule('git'))).toBeNull();
    expect(formatAllowScopes(['memory_save', 'memory_search'].map((e) => scopeRule(e)))).toBe(
      'ops: create, search'
    );
  });
});

describe('isPlainNameAlias', () => {
  it('is true only for a definition name that is not an old id or live id', () => {
    expect(isPlainNameAlias('bash', ['terminal', 'bash'])).toBe(true);
    expect(isPlainNameAlias('BASH', ['terminal', 'bash'])).toBe(true);
    expect(isPlainNameAlias('zsh', ['terminal', 'bash'])).toBe(false);
    // table_read is an old id: it keeps its op pin instead.
    expect(isPlainNameAlias('table_read', ['table_read', 'table_write'])).toBe(false);
    expect(isPlainNameAlias('bash', ['bash'], { activeToolIds: new Set(['bash']) })).toBe(false);
    expect(isPlainNameAlias('bash', undefined)).toBe(false);
  });
});

describe('ruleNamesTool — display names, narrow allow and broad deny', () => {
  const shell = { id: 'shell', name: 'Shell' };

  it('reads the id on both sides', () => {
    expect(ruleNamesTool('shell', shell, 'allow')).toBe(true);
    expect(ruleNamesTool('shell', shell, 'deny')).toBe(true);
  });

  it('an allow names the tool only by its exact display name', () => {
    expect(ruleNamesTool('Shell', shell, 'allow')).toBe(true);
    expect(ruleNamesTool('SHELL', shell, 'allow')).toBe(false);
    expect(ruleNamesTool('shell ', shell, 'allow')).toBe(false);
  });

  it('a deny names the tool by its id or display name in any case', () => {
    expect(ruleNamesTool('Shell', shell, 'deny')).toBe(true);
    expect(ruleNamesTool('SHELL', shell, 'deny')).toBe(true);
    const clock = { id: 'get_current_datetime', name: 'Current Time' };
    expect(ruleNamesTool('GET_CURRENT_DATETIME', clock, 'deny')).toBe(true);
    expect(ruleNamesTool('current time', clock, 'deny')).toBe(true);
    expect(ruleNamesTool('GET_CURRENT_DATETIME', clock, 'allow')).toBe(false);
  });

  it('never reads a definition name, an old id or another live id as the tool', () => {
    expect(ruleNamesTool('bash', shell, 'deny')).toBe(false);
    // exec_command is an old id: it keeps its own pins (scopeRule).
    expect(ruleNamesTool('exec_command', { id: 'shell', name: 'exec_command' }, 'allow')).toBe(
      false
    );
    expect(
      ruleNamesTool('Shell', shell, 'deny', { activeToolIds: new Set(['shell', 'Shell']) })
    ).toBe(false);
    // A tool with no display name is named by its id alone.
    expect(ruleNamesTool('', { id: 'shell', name: '' }, 'allow')).toBe(false);
    expect(ruleNamesTool('', { id: 'shell', name: '' }, 'deny')).toBe(false);
  });
});

describe('doc history family access', () => {
  const family = ['snapshot', 'list-snapshots', 'restore', 'delete-snapshot'];
  it('allows and denies exactly the history family, not unrelated doc operations', () => {
    for (const op of family) {
      expect(evaluateOpAccess(allow('doc_history'), 'doc', op).decision).toBe('allow');
      expect(evaluateOpAccess(deny('doc_history'), 'doc', op).decision).toBe('deny');
    }
    for (const op of [
      'get',
      'create',
      'update',
      'delete',
      'diff',
      'duplicate',
      'convert-to-container',
      null,
    ]) {
      expect(evaluateOpAccess(allow('doc_history'), 'doc', op).decision).toBe('ask');
      expect(evaluateOpAccess(deny('doc_history'), 'doc', op).decision).toBe('allow');
    }
    expect(isOpScopedEntry('doc_history')).toBe(true);
    expect(formatAllowScopes([scopeRule('doc_history')])).toBe(
      'ops: snapshot, list-snapshots, restore, delete-snapshot'
    );
  });
  it.each([
    ['snapshot_doc', 'snapshot'],
    ['list_snapshots', 'list-snapshots'],
    ['restore_snapshot', 'restore'],
    ['delete_snapshot', 'delete-snapshot'],
    ['duplicate_doc', 'duplicate'],
    ['diff_doc', 'diff'],
    ['convert_doc_to_container', 'convert-to-container'],
  ])('keeps %s narrow', (id, selected) => {
    for (const name of [id, `workspace_${id}`]) {
      for (const op of [...family, 'get', 'delete', 'diff', 'duplicate', 'convert-to-container']) {
        expect(evaluateOpAccess(allow(name), 'doc', op).decision).toBe(
          op === selected ? 'allow' : 'ask'
        );
        expect(evaluateOpAccess(deny(name), 'doc', op).decision).toBe(
          op === selected ? 'deny' : 'allow'
        );
      }
    }
  });
  it('keeps live history ids exact during rollout', () => {
    expect(scopeRule('doc_history', { activeToolIds: new Set(['doc_history']) })).toMatchObject({
      toolId: 'doc_history',
      op: null,
      pins: {},
    });
  });
});

describe('table read-class expansion is deny-only', () => {
  test.each(['fields', 'query'])(
    '%s respects legacy read denies without extending scoped allows',
    (op) => {
      expect(evaluateOpAccess(deny('table_read'), 'table', op).decision).toBe('deny');
      expect(evaluateOpAccess(allow('table_read'), 'table', op).decision).toBe('ask');
      expect(evaluateOpAccess(allow('table'), 'table', op).decision).toBe('allow');
      expect(
        evaluateOpAccess(
          { mode: 'allow_list', allowList: ['table'], denyList: ['table_read'] },
          'table',
          op
        ).decision
      ).toBe('deny');
    }
  );
  test('read deny does not block writes', () => {
    expect(evaluateOpAccess(deny('table_read'), 'table', 'write').decision).toBe('allow');
    expect(evaluateOpAccess(allow('table_read'), 'table', 'read').decision).toBe('allow');
  });
});

describe('thread membership ops count as update for denies only', () => {
  // add_agents/remove_agents were fields of update: a stored deny on any old
  // update id must keep blocking them.
  test.each(['thread_update', 'update_thread', 'configure_thread', 'thread_settings_update'])(
    'a deny on %s blocks add_agents and remove_agents',
    (rule) => {
      for (const op of ['add_agents', 'remove_agents']) {
        expect(evaluateOpAccess(deny(rule), 'thread', op).decision).toBe('deny');
      }
    }
  );
  test('without extending scoped allows, and without blocking other ops', () => {
    expect(evaluateOpAccess(allow('thread_update'), 'thread', 'add_agents').decision).toBe('ask');
    expect(evaluateOpAccess(allow('thread'), 'thread', 'remove_agents').decision).toBe('allow');
    expect(evaluateOpAccess(deny('thread_update'), 'thread', 'leave').decision).toBe('allow');
    expect(evaluateOpAccess(deny('thread_update'), 'thread', 'send').decision).toBe('allow');
  });
});
