import { describe, it, expect } from '@jest/globals';
import {
  classifyToolCall,
  readSupersedes,
  toolCallHash,
  canonicalizeInput,
} from '@server/services/SocketService/handlers/chatPhases/toolCallTargeting';

describe('toolCallHash / canonicalizeInput', () => {
  it('is stable regardless of key order', () => {
    const a = toolCallHash('file_read', { path: '/x', start_line: 1 });
    const b = toolCallHash('file_read', { start_line: 1, path: '/x' });
    expect(a).toBe(b);
  });

  it('differs on different args or tool', () => {
    expect(toolCallHash('file_read', { path: '/x' })).not.toBe(
      toolCallHash('file_read', { path: '/y' })
    );
    expect(toolCallHash('file_read', { path: '/x' })).not.toBe(
      toolCallHash('get_doc', { path: '/x' })
    );
  });

  it('canonicalizes nested objects/arrays deterministically', () => {
    expect(canonicalizeInput({ b: [2, 1], a: 1 })).toBe(canonicalizeInput({ a: 1, b: [2, 1] }));
  });
});

describe('classifyToolCall', () => {
  it('classifies a whole-file read', () => {
    const c = classifyToolCall('file_read', { path: '/x' });
    expect(c.role).toBe('read');
    expect(c.subject).toBe('/x');
    expect(c.fullCoverage).toBe(true);
    expect(c.mutation).toBeNull();
  });

  it('marks a range read as not full coverage', () => {
    const c = classifyToolCall('file_read', { path: '/x', start_line: 1, end_line: 5 });
    expect(c.role).toBe('read');
    expect(c.fullCoverage).toBe(false);
  });

  it('classifies file/doc mutations as subject-scoped', () => {
    expect(classifyToolCall('file_edit', { path: '/x' }).mutation).toEqual({
      scope: 'subject',
      subject: '/x',
    });
    expect(classifyToolCall('edit_doc', { doc_id: 'doc-1' }).mutation).toEqual({
      scope: 'subject',
      subject: 'doc-1',
    });
    // edit_doc via the `id` alias still resolves a subject.
    expect(classifyToolCall('edit_doc', { id: 'doc-9' }).mutation).toEqual({
      scope: 'subject',
      subject: 'doc-9',
    });
  });

  it('classifies doc(op) like the tool each op replaced', () => {
    // get = get_doc (a full-coverage read of its subject)
    expect(classifyToolCall('doc', { op: 'get', id: 'doc-1' })).toMatchObject({
      role: 'read',
      subject: 'doc-1',
      fullCoverage: true,
    });
    // update = edit_doc, delete = delete_doc (subject-scoped mutations)
    for (const op of [
      'update',
      'delete',
      'snapshot',
      'list-snapshots',
      'restore',
      'delete-snapshot',
      'convert-to-container',
    ]) {
      expect(classifyToolCall('doc', { op, id: 'doc-1' }).mutation).toEqual({
        scope: 'subject',
        subject: 'doc-1',
      });
    }
    // create = create_doc (no prior subject; deduped only on exact input)
    expect(classifyToolCall('doc', { op: 'create', title: 'T' })).toMatchObject({
      role: 'other',
      mutation: null,
    });
  });

  it('classifies exec-family tools as all-scope mutations', () => {
    expect(classifyToolCall('exec_command', { command: 'ls' }).mutation).toEqual({ scope: 'all' });
    expect(classifyToolCall('shell_exec', { command: 'ls' }).mutation).toEqual({ scope: 'all' });
  });

  it('makes database writes invalidate database reads, which never supersede each other', () => {
    const read = classifyToolCall('table_read', { sql: 'select 1' });
    expect(read).toEqual({
      role: 'read',
      subject: 'database',
      fullCoverage: false,
      mutation: null,
    });
    expect(classifyToolCall('database_query', { sql: 'select 1' }).subject).toBe('database');
    for (const tool of ['table_write', 'table_schema', 'table_delete', 'database_execute']) {
      expect(classifyToolCall(tool, { table: 'companies' }).mutation).toEqual({
        scope: 'subject',
        subject: 'database',
      });
    }
  });

  it('classifies table(op) like the tool each op replaced', () => {
    expect(classifyToolCall('table', { op: 'read', sql: 'select 1' })).toEqual({
      role: 'read',
      subject: 'database',
      fullCoverage: false,
      mutation: null,
    });
    for (const input of [
      { op: 'fields', table: 'companies' },
      { op: 'query', sql: 'select 1' },
    ]) {
      expect(classifyToolCall('table', input)).toEqual({
        role: 'read',
        subject: 'database',
        fullCoverage: false,
        mutation: null,
      });
    }
    for (const op of ['write', 'schema', 'delete']) {
      expect(classifyToolCall('table', { op, table: 'companies' }).mutation).toEqual({
        scope: 'subject',
        subject: 'database',
      });
    }
  });

  it('makes change_color_theme set/reset invalidate an earlier get of the theme', () => {
    expect(classifyToolCall('change_color_theme', { op: 'get' })).toEqual({
      role: 'read',
      subject: 'appearance.colors',
      fullCoverage: true,
      mutation: null,
    });
    for (const input of [{ op: 'set', colors: { text: '#112233' } }, { op: 'reset' }]) {
      expect(classifyToolCall('change_color_theme', input)).toEqual({
        role: 'mutation',
        subject: 'appearance.colors',
        fullCoverage: false,
        mutation: { scope: 'subject', subject: 'appearance.colors' },
      });
    }
  });

  it('makes workspace_instructions set invalidate an earlier get of the instructions', () => {
    expect(classifyToolCall('workspace_instructions', { op: 'get' })).toEqual({
      role: 'read',
      subject: 'agent.global_instructions',
      fullCoverage: true,
      mutation: null,
    });
    expect(classifyToolCall('workspace_instructions', { op: 'set', text: 'Be brief.' })).toEqual({
      role: 'mutation',
      subject: 'agent.global_instructions',
      fullCoverage: false,
      mutation: { scope: 'subject', subject: 'agent.global_instructions' },
    });
  });

  it('falls back to all-scope when a known mutation has no determinable subject', () => {
    expect(classifyToolCall('file_edit', {}).mutation).toEqual({ scope: 'all' });
  });

  it('treats unknown tools as other/no-subject (deduped only on exact input)', () => {
    const c = classifyToolCall('workspace_search', { query: 'x' });
    expect(c.role).toBe('other');
    expect(c.subject).toBeNull();
    expect(c.mutation).toBeNull();
  });
});

describe('readSupersedes', () => {
  it('supersedes an exact-identical earlier read', () => {
    expect(readSupersedes({ hash: 'h', fullCoverage: false }, { hash: 'h' })).toBe(true);
  });

  it('a full-coverage read supersedes any earlier read of the target', () => {
    expect(readSupersedes({ hash: 'newer', fullCoverage: true }, { hash: 'older' })).toBe(true);
  });

  it('a narrower (range) read does not supersede a different earlier read', () => {
    expect(readSupersedes({ hash: 'newer', fullCoverage: false }, { hash: 'older' })).toBe(false);
  });
});
