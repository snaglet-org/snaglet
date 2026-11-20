/**
 * toolPermission — the pure call-time permission engine for the dangerous
 * "computer" tools. Covers rule parsing, the three matchers (command/path/sql),
 * and the deny>allow>default verdict across mode all/allow_list/deny_list.
 */
import os from 'os';
import path from 'path';
import type { ToolAccessConfig } from '@snaglet/shared/types';
import {
  parseRule,
  matchCommand,
  matchPath,
  matchSql,
  classifySql,
  hasShellChaining,
  isGuardedTool,
  evaluateToolPermission,
} from '@server/services/ToolService/lib/toolPermission';

function access(partial: Partial<ToolAccessConfig>): ToolAccessConfig {
  return { mode: 'all', allowList: [], denyList: [], ...partial };
}

describe('parseRule', () => {
  it('parses a bare tool id', () => {
    expect(parseRule('shell_exec')).toEqual({ toolId: 'shell_exec', specifier: null });
  });
  it('parses a specifier', () => {
    expect(parseRule('shell_exec(git:*)')).toEqual({ toolId: 'shell_exec', specifier: 'git:*' });
  });
  it('trims whitespace inside and around', () => {
    expect(parseRule('  file_write( /a/** ) ')).toEqual({
      toolId: 'file_write',
      specifier: '/a/**',
    });
  });
  it('treats an empty specifier as bare', () => {
    expect(parseRule('shell_exec()')).toEqual({ toolId: 'shell_exec', specifier: null });
  });
  it('fails safe on an unterminated paren (whole string is the id)', () => {
    expect(parseRule('shell_exec(git').toolId).toBe('shell_exec(git');
    expect(parseRule('shell_exec(git').specifier).toBeNull();
  });
});

describe('hasShellChaining', () => {
  it.each(['git log && rm -rf ~', 'a; b', 'a | b', 'a || b', '`x`', '$(x)', 'a > f', 'a\nb'])(
    'flags %s',
    (cmd) => expect(hasShellChaining(cmd)).toBe(true)
  );
  it('passes a plain command', () => {
    expect(hasShellChaining('git status --short')).toBe(false);
  });
});

describe('matchCommand', () => {
  it('matches the wildcard', () => {
    expect(matchCommand('*', 'anything at all', true)).toBe(true);
  });
  it('matches exact', () => {
    expect(matchCommand('git status', 'git status', true)).toBe(true);
    expect(matchCommand('git status', 'git status --short', true)).toBe(false);
  });
  it('matches a prefix rule', () => {
    expect(matchCommand('git:*', 'git', true)).toBe(true);
    expect(matchCommand('git:*', 'git push origin main', true)).toBe(true);
    expect(matchCommand('git:*', 'gitfoo', true)).toBe(false);
  });
  it('rejects a chained command under an allow prefix rule', () => {
    expect(matchCommand('git:*', 'git status && rm -rf ~', true)).toBe(false);
  });
  it('still matches a chained command under a deny prefix rule', () => {
    expect(matchCommand('git:*', 'git status && rm -rf ~', false)).toBe(true);
  });
});

describe('matchPath', () => {
  it('matches a ** glob subtree', () => {
    expect(matchPath('/proj/**', '/proj/src/a.ts')).toBe(true);
    expect(matchPath('/proj/**', '/proj')).toBe(true);
    expect(matchPath('/proj/**', '/other/a.ts')).toBe(false);
  });
  it('matches a bare directory as a prefix', () => {
    expect(matchPath('/proj', '/proj/src/a.ts')).toBe(true);
    expect(matchPath('/proj', '/projector/a.ts')).toBe(false);
  });
  it('collapses .. so it cannot escape an allowed subtree', () => {
    expect(matchPath('/proj/**', '/proj/../etc/passwd')).toBe(false);
  });
  it('expands ~ in the specifier', () => {
    expect(matchPath('~/safe/**', path.join(os.homedir(), 'safe', 'a.txt'))).toBe(true);
  });
  it('single * does not cross a slash', () => {
    expect(matchPath('/proj/*', '/proj/a.ts')).toBe(true);
    expect(matchPath('/proj/*', '/proj/sub/a.ts')).toBe(false);
  });
});

describe('classifySql / matchSql', () => {
  it('classifies leading keyword', () => {
    expect(classifySql('SELECT * FROM x')).toBe('select');
    expect(classifySql('  delete from x')).toBe('delete');
    expect(classifySql('/* c */ UPDATE x SET a=1')).toBe('update');
    expect(classifySql('-- note\nINSERT INTO x VALUES (1)')).toBe('insert');
  });
  it('resolves a CTE to its write kind', () => {
    expect(classifySql('WITH t AS (SELECT 1) DELETE FROM x WHERE id IN (SELECT * FROM t)')).toBe(
      'delete'
    );
    expect(classifySql('WITH t AS (SELECT 1) SELECT * FROM t')).toBe('select');
  });
  it('matches statement-type specifiers', () => {
    expect(matchSql('select', 'select 1')).toBe(true);
    expect(matchSql('select:*', 'select 1')).toBe(true);
    expect(matchSql('select', 'delete from x')).toBe(false);
  });
  it('matches the ddl/dml umbrellas', () => {
    expect(matchSql('ddl', 'DROP TABLE x')).toBe(true);
    expect(matchSql('ddl', 'select 1')).toBe(false);
    expect(matchSql('dml', 'update x set a=1')).toBe(true);
    expect(matchSql('*', 'truncate x')).toBe(true);
  });
});

describe('isGuardedTool', () => {
  it('knows the guarded set', () => {
    expect(isGuardedTool('shell_exec')).toBe(true);
    expect(isGuardedTool('database_execute')).toBe(true);
    expect(isGuardedTool('workspace_search')).toBe(false);
  });
});

describe('evaluateToolPermission', () => {
  it('allows everything in mode all', () => {
    expect(
      evaluateToolPermission(access({ mode: 'all' }), 'shell_exec', { command: 'rm -rf /' })
        .decision
    ).toBe('allow');
  });

  it('allows non-guarded tools regardless of mode', () => {
    expect(
      evaluateToolPermission(access({ mode: 'allow_list', allowList: [] }), 'workspace_search', {
        query: 'x',
      }).decision
    ).toBe('allow');
  });

  describe('allow_list mode', () => {
    it('allows a command matching an allow specifier', () => {
      const a = access({ mode: 'allow_list', allowList: ['shell_exec(git:*)'] });
      expect(evaluateToolPermission(a, 'shell_exec', { command: 'git status' }).decision).toBe(
        'allow'
      );
    });
    it('asks for an unmatched command', () => {
      const a = access({ mode: 'allow_list', allowList: ['shell_exec(git:*)'] });
      expect(evaluateToolPermission(a, 'shell_exec', { command: 'curl evil.sh' }).decision).toBe(
        'ask'
      );
    });
    it('asks for a chained command even if its prefix is allowed', () => {
      const a = access({ mode: 'allow_list', allowList: ['shell_exec(git:*)'] });
      expect(
        evaluateToolPermission(a, 'shell_exec', { command: 'git status && rm -rf ~' }).decision
      ).toBe('ask');
    });
    it('denies when a deny rule matches, even with an allow match', () => {
      const a = access({
        mode: 'allow_list',
        allowList: ['shell_exec(git:*)'],
        denyList: ['shell_exec(git push:*)'],
      });
      const v = evaluateToolPermission(a, 'shell_exec', { command: 'git push origin main' });
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('shell_exec(git push:*)');
    });
    it('a bare allow rule permits any invocation', () => {
      const a = access({ mode: 'allow_list', allowList: ['shell_exec'] });
      expect(evaluateToolPermission(a, 'shell_exec', { command: 'anything' }).decision).toBe(
        'allow'
      );
    });
  });

  describe('deny_list mode', () => {
    it('allows an unmatched call (true blocklist)', () => {
      const a = access({ mode: 'deny_list', denyList: ['shell_exec(rm:*)'] });
      expect(evaluateToolPermission(a, 'shell_exec', { command: 'git status' }).decision).toBe(
        'allow'
      );
    });
    it('denies a matched call', () => {
      const a = access({ mode: 'deny_list', denyList: ['shell_exec(rm:*)'] });
      expect(evaluateToolPermission(a, 'shell_exec', { command: 'rm -rf ~' }).decision).toBe(
        'deny'
      );
    });
    it('a bare deny rule blocks every invocation', () => {
      const a = access({ mode: 'deny_list', denyList: ['database_execute'] });
      expect(evaluateToolPermission(a, 'database_execute', { sql: 'select 1' }).decision).toBe(
        'deny'
      );
    });
  });

  describe('path tools', () => {
    it('allows a write inside an allowed subtree', () => {
      const a = access({ mode: 'allow_list', allowList: ['file_write(/proj/**)'] });
      expect(evaluateToolPermission(a, 'file_write', { path: '/proj/a.txt' }).decision).toBe(
        'allow'
      );
    });
    it('asks for a write outside the allowed subtree', () => {
      const a = access({ mode: 'allow_list', allowList: ['file_write(/proj/**)'] });
      expect(evaluateToolPermission(a, 'file_write', { path: '/etc/passwd' }).decision).toBe('ask');
    });
  });

  describe('apply_patch (multi-path)', () => {
    const patch = (p: string) =>
      `*** Begin Patch\n*** Update File: ${p}\n@@\n-old\n+new\n*** End Patch`;
    it('allows when every touched path is inside an allowed subtree', () => {
      const a = access({ mode: 'allow_list', allowList: ['apply_patch(/proj/**)'] });
      expect(
        evaluateToolPermission(a, 'apply_patch', { patch: patch('/proj/src/a.ts') }).decision
      ).toBe('allow');
    });
    it('asks when any touched path is outside', () => {
      const a = access({ mode: 'allow_list', allowList: ['apply_patch(/proj/**)'] });
      expect(
        evaluateToolPermission(a, 'apply_patch', { patch: patch('/etc/shadow') }).decision
      ).toBe('ask');
    });
    it('resolves relative patch paths against workdir', () => {
      const a = access({ mode: 'allow_list', allowList: ['apply_patch(/proj/**)'] });
      const rel = `*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch`;
      expect(
        evaluateToolPermission(a, 'apply_patch', { patch: rel, workdir: '/proj' }).decision
      ).toBe('allow');
    });
  });

  describe('sql tool', () => {
    it('allows a select when only selects are allowed', () => {
      const a = access({ mode: 'allow_list', allowList: ['database_execute(select:*)'] });
      expect(
        evaluateToolPermission(a, 'database_execute', { sql: 'select * from x' }).decision
      ).toBe('allow');
    });
    it('asks for a delete when only selects are allowed', () => {
      const a = access({ mode: 'allow_list', allowList: ['database_execute(select:*)'] });
      expect(evaluateToolPermission(a, 'database_execute', { sql: 'delete from x' }).decision).toBe(
        'ask'
      );
    });
    it('denies ddl via a deny umbrella', () => {
      const a = access({ mode: 'deny_list', denyList: ['database_execute(ddl)'] });
      expect(evaluateToolPermission(a, 'database_execute', { sql: 'drop table x' }).decision).toBe(
        'deny'
      );
    });
  });

  describe('permanent catalog aliases', () => {
    it('applies a shell git deny to canonical git pushes', () => {
      const a = access({ mode: 'deny_list', denyList: ['shell_exec(git:*)'] });

      expect(
        evaluateToolPermission(a, 'git', {
          subcommand: 'push',
          remote: 'origin',
          branch: 'feature',
        })
      ).toMatchObject({ decision: 'deny', rule: 'shell_exec(git:*)' });
    });

    it('applies a shell git deny to legacy git_push calls', () => {
      const a = access({ mode: 'deny_list', denyList: ['shell_exec(git:*)'] });

      expect(
        evaluateToolPermission(a, 'git_push', {
          remote: 'origin',
          branch: 'feature',
        })
      ).toMatchObject({ decision: 'deny', rule: 'shell_exec(git:*)' });
    });

    it('matches a stored legacy-id deny rule against the canonical git tool', () => {
      const a = access({ mode: 'deny_list', denyList: ['git_push(git push:*)'] });

      expect(
        evaluateToolPermission(a, 'git', {
          subcommand: 'push',
          remote: 'origin',
          branch: 'feature',
        })
      ).toMatchObject({ decision: 'deny', rule: 'git_push(git push:*)' });
    });

    it('matches a canonical deny rule against a legacy-id call', () => {
      const a = access({ mode: 'deny_list', denyList: ['git(git push:*)'] });

      expect(
        evaluateToolPermission(a, 'git_push', {
          remote: 'origin',
          branch: 'feature',
        })
      ).toMatchObject({ decision: 'deny', rule: 'git(git push:*)' });
    });
  });
});

// Known bypass shapes that must stay closed.
describe('evaluateToolPermission — hardening', () => {
  it('does not let a multi-statement SQL slip past a select-only allow', () => {
    const a = access({ mode: 'allow_list', allowList: ['database_execute(select:*)'] });
    expect(
      evaluateToolPermission(a, 'database_execute', { sql: 'select 1; drop table users' }).decision
    ).toBe('ask');
  });
  it.each([
    "select '-- x'; drop table users",
    "select '/*'; update accounts set balance=0; select '*/'",
    'select $$ -- $$ ; drop table x',
  ])('does not let a write hide behind an in-literal comment: %s', (sql) => {
    const a = access({ mode: 'allow_list', allowList: ['database_execute(select:*)'] });
    expect(evaluateToolPermission(a, 'database_execute', { sql }).decision).toBe('ask');
  });
  it('still treats real leading comments as no-ops (not a hidden statement)', () => {
    const a = access({ mode: 'allow_list', allowList: ['database_execute(select:*)'] });
    expect(
      evaluateToolPermission(a, 'database_execute', { sql: '/* note */ select 1' }).decision
    ).toBe('allow');
  });
  it('classifies EXPLAIN ANALYZE by its inner statement', () => {
    const a = access({ mode: 'deny_list', denyList: ['database_execute(dml)'] });
    expect(
      evaluateToolPermission(a, 'database_execute', { sql: 'explain analyze delete from users' })
        .decision
    ).toBe('deny');
  });
  it('guards database_query (raw SQL) too', () => {
    const a = access({ mode: 'allow_list', allowList: ['database_query(select:*)'] });
    expect(evaluateToolPermission(a, 'database_query', { sql: 'select 1' }).decision).toBe('allow');
    expect(
      evaluateToolPermission(a, 'database_query', { sql: 'select 1; delete from x' }).decision
    ).toBe('ask');
  });
  it('extracts apply_patch paths from the content field, not just patch', () => {
    const a = access({ mode: 'allow_list', allowList: ['apply_patch(/proj/**)'] });
    const body = (p: string) =>
      `*** Begin Patch\n*** Update File: ${p}\n@@\n-old\n+new\n*** End Patch`;
    expect(
      evaluateToolPermission(a, 'apply_patch', { content: body('/etc/shadow') }).decision
    ).toBe('ask');
    expect(evaluateToolPermission(a, 'apply_patch', { content: body('/proj/a.ts') }).decision).toBe(
      'allow'
    );
  });
  it('catches an env-prefixed / double-spaced command in a deny rule', () => {
    const a = access({ mode: 'deny_list', denyList: ['shell_exec(rm:*)'] });
    expect(evaluateToolPermission(a, 'shell_exec', { command: 'FOO=bar rm -rf ~' }).decision).toBe(
      'deny'
    );
    expect(evaluateToolPermission(a, 'shell_exec', { command: 'rm  -rf  /' }).decision).toBe(
      'deny'
    );
  });
  it('does not silently allow an env-prefixed command under an allow prefix rule', () => {
    const a = access({ mode: 'allow_list', allowList: ['shell_exec(git:*)'] });
    expect(
      evaluateToolPermission(a, 'shell_exec', { command: 'LD_PRELOAD=evil.so git status' }).decision
    ).toBe('ask');
  });
  it('resolves a relative file path against the provided cwd', () => {
    const a = access({ mode: 'allow_list', allowList: ['file_write(/proj/**)'] });
    expect(
      evaluateToolPermission(a, 'file_write', { path: 'src/a.ts' }, { cwd: '/proj' }).decision
    ).toBe('allow');
    expect(
      evaluateToolPermission(a, 'file_write', { path: 'src/a.ts' }, { cwd: '/other' }).decision
    ).toBe('ask');
  });
});

describe('kind-scoped container aliases (move_container / archive_container)', () => {
  const allowOnly = (entry: string) => access({ mode: 'allow_list', allowList: [entry] });

  it.each(['move_container', 'container_move'])(
    'allow %s: node(op:move) on a doc, thread, sketch or unhinted id is not allowed',
    (entry) => {
      for (const input of [
        { op: 'move', id: 'doc-1', new_parent_id: 'c-1' },
        { op: 'move', id: 'doc-1', kind: 'doc', new_parent_id: 'c-1' },
        { op: 'move', id: 't-1', kind: 'thread', new_parent_id: 'p-1' },
        { op: 'move', id: 's-1', kind: 'sketch', new_parent_id: 'c-1' },
      ]) {
        expect(evaluateToolPermission(allowOnly(entry), 'node', input).decision).toBe('ask');
      }
      expect(
        evaluateToolPermission(allowOnly(entry), 'node', {
          op: 'move',
          id: 'c-2',
          kind: 'container',
          new_parent_id: 'c-1',
        }).decision
      ).toBe('allow');
    }
  );

  it('calling the old id itself still works under its own allow (kind is pinned)', () => {
    expect(
      evaluateToolPermission(allowOnly('move_container'), 'move_container', {
        container_id: 'c-2',
        kind: 'doc',
      }).decision
    ).toBe('allow');
    expect(
      evaluateToolPermission(allowOnly('archive_container'), 'archive_container', {
        node_id: 'c-2',
      }).decision
    ).toBe('allow');
  });

  it.each(['archive_container', 'container_archive'])(
    'allow %s: node(op:archive) on a non-container is not allowed',
    (entry) => {
      expect(
        evaluateToolPermission(allowOnly(entry), 'node', { op: 'archive', id: 'doc-1' }).decision
      ).toBe('ask');
      expect(
        evaluateToolPermission(allowOnly(entry), 'node', {
          op: 'archive',
          id: 'c-1',
          kind: 'container',
        }).decision
      ).toBe('allow');
    }
  );

  it('allow node (tool-wide) still covers every kind', () => {
    expect(
      evaluateToolPermission(allowOnly('node'), 'node', {
        op: 'move',
        id: 'doc-1',
        new_parent_id: 'c',
      }).decision
    ).toBe('allow');
  });
});

// Alias ids that pin a param other than `op` (git_status → git{subcommand},
// google_gmail_send → google_gmail{operation}, …). As with the container
// aliases above, an allow rule naming the alias covers only the calls that
// alias could make (every pin matches), while a deny rule naming it stays
// broad (the whole tool, or its op when it pins one). Real alias table.
describe('param-pinned aliases: narrow allow, broad deny', () => {
  const allowOnly = (...allowList: string[]) => access({ mode: 'allow_list', allowList });
  const denyOnly = (...denyList: string[]) => access({ mode: 'deny_list', denyList });
  const verdict = (a: ToolAccessConfig, toolId: string, input: Record<string, unknown>) =>
    evaluateToolPermission(a, toolId, input).decision;
  const PUSH = { subcommand: 'push', remote: 'origin', branch: 'main' };

  describe('git_* (subcommand)', () => {
    it('allow git_status: git status passes, git push is refused', () => {
      expect(verdict(allowOnly('git_status'), 'git', { subcommand: 'status' })).toBe('allow');
      expect(verdict(allowOnly('git_status'), 'git', PUSH)).toBe('ask');
      for (const subcommand of ['commit', 'checkout', 'stash', 'pull', 'log']) {
        expect(verdict(allowOnly('git_status'), 'git', { subcommand })).toBe('ask');
      }
    });

    it('a call that omits the pinned subcommand is not covered', () => {
      expect(verdict(allowOnly('git_status'), 'git', {})).toBe('ask');
    });

    it('calls made through the old ids keep working (the pin is forced)', () => {
      expect(verdict(allowOnly('git_status'), 'git_status', {})).toBe('allow');
      expect(verdict(allowOnly('git_status'), 'git_status', { subcommand: 'push' })).toBe('allow');
      expect(verdict(allowOnly('git_status'), 'git_push', { remote: 'origin' })).toBe('ask');
    });

    it('a pinned allow next to a specifier rule never acts as a bare allow', () => {
      const a = allowOnly('git_status', 'git(git push:*)');
      expect(verdict(a, 'git', { subcommand: 'status' })).toBe('allow');
      expect(verdict(a, 'git', PUSH)).toBe('allow');
      expect(verdict(a, 'git', { subcommand: 'commit', message: 'x' })).toBe('ask');
    });

    it('several pinned allows union their pins', () => {
      const a = allowOnly('git_status', 'git_log');
      expect(verdict(a, 'git', { subcommand: 'log' })).toBe('allow');
      expect(verdict(a, 'git', PUSH)).toBe('ask');
    });

    it('allow git (canonical) still covers every subcommand', () => {
      expect(verdict(allowOnly('git'), 'git', PUSH)).toBe('allow');
    });

    it('deny git_push stays tool-wide: it denies push and status alike', () => {
      expect(verdict(denyOnly('git_push'), 'git', PUSH)).toBe('deny');
      expect(verdict(denyOnly('git_push'), 'git', { subcommand: 'status' })).toBe('deny');
    });

    it('deny git_push wins over a canonical allow', () => {
      const a = access({ mode: 'allow_list', allowList: ['git'], denyList: ['git_push'] });
      expect(verdict(a, 'git', PUSH)).toBe('deny');
    });

    it('a git command rule stored under a shell id still governs the git tool', () => {
      const a = allowOnly('exec_command(git status:*)');
      expect(verdict(a, 'git', { subcommand: 'status' })).toBe('allow');
      expect(verdict(a, 'git', PUSH)).toBe('ask');
    });
  });

  describe('google_*_* (operation)', () => {
    it('allow google_gmail_send: send passes, read/list/delete are refused', () => {
      const a = allowOnly('google_gmail_send');
      expect(verdict(a, 'google_gmail', { operation: 'send', to: 'user@example.com' })).toBe(
        'allow'
      );
      for (const operation of ['get_message', 'list', 'search', 'delete', 'trash', 'forward']) {
        expect(verdict(a, 'google_gmail', { operation })).toBe('ask');
      }
      expect(verdict(a, 'google_gmail', {})).toBe('ask');
      expect(verdict(a, 'google_gmail_send', { to: 'user@example.com' })).toBe('allow');
    });

    it('google_gmail_labels pins list_labels', () => {
      const a = allowOnly('google_gmail_labels');
      expect(verdict(a, 'google_gmail', { operation: 'list_labels' })).toBe('allow');
      expect(verdict(a, 'google_gmail', { operation: 'modify_labels' })).toBe('ask');
    });

    it('drive admin ids scope to their operation on google_drive_admin', () => {
      const a = allowOnly('google_drive_share_file');
      expect(verdict(a, 'google_drive_admin', { operation: 'share_file' })).toBe('allow');
      expect(verdict(a, 'google_drive_admin', { operation: 'delete_file' })).toBe('ask');
    });

    it.each([
      ['google_calendar_list_events', 'google_calendar', 'list_events', 'delete_event'],
      ['google_docs_read', 'google_docs', 'read', 'append'],
      ['google_sheets_read', 'google_sheets', 'read', 'append'],
      ['google_drive_list_files', 'google_drive', 'list_files', 'download_file'],
    ])('allow %s covers only its operation', (entry, toolId, own, other) => {
      expect(verdict(allowOnly(entry), toolId, { operation: own })).toBe('allow');
      expect(verdict(allowOnly(entry), toolId, { operation: other })).toBe('ask');
    });

    it('deny google_gmail_send denies the whole tool, in either mode', () => {
      expect(verdict(denyOnly('google_gmail_send'), 'google_gmail', { operation: 'list' })).toBe(
        'deny'
      );
      const a = access({
        mode: 'allow_list',
        allowList: ['google_gmail'],
        denyList: ['google_gmail_send'],
      });
      expect(verdict(a, 'google_gmail', { operation: 'send' })).toBe('deny');
      expect(verdict(a, 'google_gmail', { operation: 'list' })).toBe('deny');
    });
  });

  describe('other param-pinning families', () => {
    it.each([
      // [entry, tool, covered input, refused input]
      ['send_imessage', 'imessage', { operation: 'send' }, { operation: 'read' }],
      ['read_imessage', 'imessage', { operation: 'read' }, { operation: 'send' }],
      ['snapshot_doc', 'doc', { op: 'snapshot' }, { op: 'delete-snapshot' }],
      ['list_snapshots', 'doc', { op: 'list-snapshots' }, { op: 'restore' }],
      ['workspace_search', 'search', { kind: 'workspace' }, { kind: 'code' }],
      ['doc_search', 'search', { kind: 'docs' }, { kind: 'files' }],
      [
        'workspace_list_archived',
        'search',
        { kind: 'workspace', archived_only: true },
        { kind: 'workspace' },
      ],
      ['workspace_resolve_path', 'resolve_path', { domain: 'workspace' }, { domain: 'filesystem' }],
      ['get_local_context', 'orient', { mode: 'local' }, { mode: 'workspace' }],
      [
        'update_identity',
        'agent',
        { op: 'update', scope: 'self' },
        { op: 'update', agent_id: 'test-agent-a' },
      ],
      [
        'self_inspect',
        'agent',
        { op: 'get', view: 'runtime_self' },
        { op: 'get', agent: 'test-agent-a' },
      ],
      [
        'get_providers',
        'model',
        { op: 'list', operation: 'providers' },
        { op: 'list', operation: 'models' },
      ],
      ['view_image', 'file', { op: 'read', mode: 'image' }, { op: 'read', path: '/tmp/a' }],
      [
        'message_context',
        'thread',
        { op: 'read', mode: 'message_context' },
        { op: 'read', thread_id: 't-1' },
      ],
      [
        'workspace_project_tree',
        'node',
        { op: 'tree', scope: 'current_project' },
        { op: 'tree', id: 'c-1' },
      ],
      [
        'workspace_archive_node',
        'node',
        { op: 'archive', kind: 'node', id: 'doc-1' },
        { op: 'archive', kind: 'container', id: 'c-1' },
      ],
    ])('allow %s on %s covers only its pinned calls', (entry, toolId, covered, refused) => {
      expect(verdict(allowOnly(entry), toolId, covered)).toBe('allow');
      expect(verdict(allowOnly(entry), toolId, refused)).toBe('ask');
      // The alias itself still reaches its own scope.
      expect(verdict(allowOnly(entry), entry, {})).toBe('allow');
    });

    it.each([
      ['send_imessage', 'imessage', { operation: 'read' }],
      ['workspace_search', 'search', { kind: 'code' }],
      ['workspace_resolve_path', 'resolve_path', { domain: 'filesystem' }],
    ])('deny %s (no op pinned) stays tool-wide', (entry, toolId, otherCall) => {
      expect(verdict(denyOnly(entry), toolId, otherCall)).toBe('deny');
    });

    it.each([
      ['update_identity', 'agent', { op: 'update', agent_id: 'test-agent-a' }, { op: 'get' }],
      ['view_image', 'file', { op: 'read', path: '/tmp/a' }, { op: 'list' }],
      ['workspace_archive_node', 'node', { op: 'archive', kind: 'container' }, { op: 'get' }],
    ])(
      'deny %s stays op-wide: its other pins never narrow it',
      (entry, toolId, sameOp, otherOp) => {
        expect(verdict(denyOnly(entry), toolId, sameOp)).toBe('deny');
        expect(verdict(denyOnly(entry), toolId, otherOp)).toBe('allow');
      }
    );
  });

  describe('unchanged surfaces', () => {
    it('shell_exec rules still govern canonical shell runs (legacy output is not a scope)', () => {
      const a = allowOnly('shell_exec(git:*)');
      expect(verdict(a, 'shell', { op: 'run', cmd: 'git status' })).toBe('allow');
      expect(verdict(a, 'shell', { op: 'run', cmd: 'rm -rf /tmp/a' })).toBe('ask');
      expect(verdict(allowOnly('shell_exec'), 'shell', { op: 'run', cmd: 'ls' })).toBe('allow');
    });

    it('the always-available tools are never narrowed by a pinned allow', () => {
      expect(verdict(allowOnly('list_tools'), 'search_tools', { query: 'git' })).toBe('allow');
      expect(verdict(allowOnly('date_time'), 'get_current_datetime', {})).toBe('allow');
    });

    it('pin-less aliases stay tool-wide', () => {
      expect(verdict(allowOnly('mcp_server'), 'mcp', { op: 'create' })).toBe('allow');
      expect(verdict(allowOnly('workspace_bulk_export'), 'bulk_export', {})).toBe('allow');
    });

    it('canonical allows still cover every call', () => {
      expect(verdict(allowOnly('google_gmail'), 'google_gmail', { operation: 'delete' })).toBe(
        'allow'
      );
      expect(verdict(allowOnly('search'), 'search', { kind: 'code' })).toBe('allow');
    });
  });
});
