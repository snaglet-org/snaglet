import { describe, expect, it } from '@jest/globals';

import {
  activityToolNames,
  emptyFilterHint,
  resolveActivityRowFilter,
} from '@server/services/ToolService/tools/agents/activityRowFilter';

describe('activityToolNames', () => {
  it('expands a canonical id to every legacy name stored in old rows', () => {
    const names = activityToolNames('shell');
    expect(names).toEqual(
      expect.arrayContaining(['shell', 'exec_command', 'shell_exec', 'write_stdin'])
    );
  });

  it('expands a legacy id to its canonical id and siblings', () => {
    const names = activityToolNames('exec_command');
    expect(names).toEqual(expect.arrayContaining(['exec_command', 'shell', 'shell_exec']));
  });

  it('keeps an unknown name as-is', () => {
    expect(activityToolNames('  thread_send ')).toEqual(expect.arrayContaining(['thread_send']));
  });
});

describe('resolveActivityRowFilter', () => {
  it('is empty without filters', () => {
    expect(resolveActivityRowFilter({ view: 'self_history' })).toEqual({});
  });

  it('reads action_type and tool', () => {
    const f = resolveActivityRowFilter({ action_type: 'tool_call', tool: 'exec_command' });
    expect(f.actionType).toBe('tool_call');
    expect(f.tools).toEqual(expect.arrayContaining(['exec_command', 'shell']));
  });

  it('ignores blank values', () => {
    expect(resolveActivityRowFilter({ action_type: ' ', tool: '' })).toEqual({});
  });
});

describe('emptyFilterHint', () => {
  it('is one line naming the action_type values and the tool filter', () => {
    const hint = emptyFilterHint({ action_type: 'thread_send' });
    expect(hint).toBe(
      'No entries matched. action_type is tool_call|thinking; filter by tool name with tool.'
    );
    expect(hint).not.toContain('\n');
  });

  it('is undefined when no filter was set', () => {
    expect(emptyFilterHint({ view: 'self_recent' })).toBeUndefined();
  });
});
