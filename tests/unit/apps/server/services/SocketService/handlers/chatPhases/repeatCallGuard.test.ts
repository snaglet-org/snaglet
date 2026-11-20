import { describe, it, expect } from '@jest/globals';
import { createRepeatCallGuard } from '@server/services/SocketService/handlers/chatPhases/repeatCallGuard';
import { classifyToolCall } from '@server/services/SocketService/handlers/chatPhases/toolCallTargeting';

// Convenience: classify + evaluate a read call in one step.
function evalRead(
  guard: ReturnType<typeof createRepeatCallGuard>,
  tool: string,
  input: Record<string, unknown>
) {
  return guard.evaluate(tool, input, classifyToolCall(tool, input));
}

describe('createRepeatCallGuard — execute / advise / suppress ladder', () => {
  it('executes the 1st, advises the 2nd, suppresses the 3rd+ with the cached result', () => {
    const g = createRepeatCallGuard();
    const input = { path: '/x' };

    const d1 = evalRead(g, 'file_read', input);
    expect(d1.kind).toBe('execute');
    g.recordResult('file_read', input, 'FILE CONTENTS');

    const d2 = evalRead(g, 'file_read', input);
    expect(d2.kind).toBe('advise');
    expect(d2.advisory).toContain('identical call #2');
    g.recordResult('file_read', input, 'FILE CONTENTS');

    const d3 = evalRead(g, 'file_read', input);
    expect(d3.kind).toBe('suppress');
    expect(d3.cachedResult).toContain('repeat call #3');
    expect(d3.cachedResult).toContain('FILE CONTENTS'); // earlier result returned verbatim

    const d4 = evalRead(g, 'file_read', input);
    expect(d4.kind).toBe('suppress');
    expect(d4.cachedResult).toContain('repeat call #4');
  });

  it('resets per run (each guard is independent)', () => {
    const input = { path: '/x' };
    const g1 = createRepeatCallGuard();
    evalRead(g1, 'file_read', input);
    g1.recordResult('file_read', input, 'a');
    evalRead(g1, 'file_read', input);
    // Fresh guard → the same call is a 1st call again.
    const g2 = createRepeatCallGuard();
    expect(evalRead(g2, 'file_read', input).kind).toBe('execute');
  });

  it('distinct inputs are tracked separately', () => {
    const g = createRepeatCallGuard();
    expect(evalRead(g, 'file_read', { path: '/x' }).kind).toBe('execute');
    expect(evalRead(g, 'file_read', { path: '/y' }).kind).toBe('execute');
  });
});

describe('createRepeatCallGuard — loop-breaking nudge cap', () => {
  it('emits a one-time nudge after 8 suppressions, then clears it', () => {
    const g = createRepeatCallGuard();
    const input = { query: 'same' };
    // Prime: two executions so the 3rd+ suppress.
    evalRead(g, 'workspace_search', input);
    g.recordResult('workspace_search', input, 'RESULT');
    evalRead(g, 'workspace_search', input);
    g.recordResult('workspace_search', input, 'RESULT');

    // Suppress 7 times — no nudge yet.
    for (let i = 0; i < 7; i++) {
      expect(evalRead(g, 'workspace_search', input).kind).toBe('suppress');
      expect(g.takePendingNudge()).toBeNull();
    }
    // 8th suppression trips the cap.
    expect(evalRead(g, 'workspace_search', input).kind).toBe('suppress');
    const nudge = g.takePendingNudge();
    expect(nudge).toContain('looping');
    // Consumed — not returned again.
    expect(g.takePendingNudge()).toBeNull();
  });
});

describe('createRepeatCallGuard — write-invalidation (never serve stale reads)', () => {
  it('read → edit(same subject) → read executes fresh (no suppression, count reset)', () => {
    const g = createRepeatCallGuard();
    const read = { path: '/x' };

    evalRead(g, 'file_read', read);
    g.recordResult('file_read', read, 'v1');
    expect(evalRead(g, 'file_read', read).kind).toBe('advise'); // 2nd
    g.recordResult('file_read', read, 'v1');

    // A write to /x invalidates the cached read + its count.
    const editCls = classifyToolCall('file_edit', { path: '/x' });
    expect(editCls.mutation).not.toBeNull();
    g.invalidate(editCls.mutation!);

    // The next identical read is a fresh 1st call — executes, never suppressed.
    expect(evalRead(g, 'file_read', read).kind).toBe('execute');
  });

  it('a subject-scoped write does not invalidate reads of other subjects', () => {
    const g = createRepeatCallGuard();
    evalRead(g, 'file_read', { path: '/x' });
    g.recordResult('file_read', { path: '/x' }, 'x');
    evalRead(g, 'file_read', { path: '/y' });
    g.recordResult('file_read', { path: '/y' }, 'y');

    g.invalidate(classifyToolCall('file_edit', { path: '/x' }).mutation!);

    // /y still cached → 2nd identical read advises; /x reset → executes.
    expect(evalRead(g, 'file_read', { path: '/y' }).kind).toBe('advise');
    expect(evalRead(g, 'file_read', { path: '/x' }).kind).toBe('execute');
  });

  it('an exec invalidates all cached reads (opaque shell effects)', () => {
    const g = createRepeatCallGuard();
    evalRead(g, 'file_read', { path: '/x' });
    g.recordResult('file_read', { path: '/x' }, 'x');
    evalRead(g, 'file_read', { path: '/y' });
    g.recordResult('file_read', { path: '/y' }, 'y');

    g.invalidate(classifyToolCall('exec_command', { command: 'make' }).mutation!);

    expect(evalRead(g, 'file_read', { path: '/x' }).kind).toBe('execute');
    expect(evalRead(g, 'file_read', { path: '/y' }).kind).toBe('execute');
  });

  it('never suppresses mutation or interactive tools', () => {
    const g = createRepeatCallGuard();
    const edit = { path: '/x', edits: [{ old_text: 'a', new_text: 'b' }] };
    for (let i = 0; i < 4; i++) {
      expect(g.evaluate('file_edit', edit, classifyToolCall('file_edit', edit)).kind).toBe(
        'execute'
      );
    }
    const ask = { question: 'ok?' };
    for (const toolId of ['ask', 'get_clarification']) {
      for (let i = 0; i < 4; i++) {
        expect(g.evaluate(toolId, ask, classifyToolCall(toolId, ask)).kind).toBe('execute');
      }
    }
  });
});
