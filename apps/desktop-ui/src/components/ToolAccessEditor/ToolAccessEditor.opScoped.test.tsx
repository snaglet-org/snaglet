/**
 * ToolAccessEditor — op-scoped rules (merged tools with per-op entries).
 *
 * After a merge, a stored entry such as `memory_save` means one op of the
 * merged `memory` tool. The editor must never drop or rewrite such entries on
 * save, should show the merged tool as checked, and labels it
 * "ops: create, search". The real op-alias registry is empty until the first
 * merge lands, so `scopeRule` is stubbed with a stand-in `memory(op)` merge.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolAccessConfig } from '@snaglet/shared/types';

vi.mock('@snaglet/shared/utils', async () => {
  const actual =
    await vi.importActual<typeof import('@snaglet/shared/utils')>('@snaglet/shared/utils');
  const ops: Record<string, string> = {
    memory_save: 'create',
    memory_search: 'search',
    memory_forget: 'delete',
  };
  return {
    ...actual,
    scopeRule: (entry: string) => {
      const rule = actual.parseRule(entry);
      const op = ops[rule.toolId];
      return op
        ? { toolId: 'memory', op, pins: { op }, specifier: rule.specifier, entry }
        : { toolId: rule.toolId, op: null, pins: {}, specifier: rule.specifier, entry };
    },
  };
});

import { ToolAccessEditor, type ToolOption } from './ToolAccessEditor';

const tools: ToolOption[] = [
  { id: 'memory', name: 'Memory', categoryPath: 'memory' },
  { id: 'get_doc', name: 'Get Doc', categoryPath: 'docs' },
];

const advance = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ToolAccessEditor — op-scoped rules', () => {
  const scoped: ToolAccessConfig = {
    mode: 'allow_list',
    allowList: ['memory_save', 'memory_search'],
    denyList: [],
  };

  it('shows the merged tool as checked and labels its scoped ops', () => {
    render(<ToolAccessEditor value={scoped} tools={tools} onSave={vi.fn()} />);
    const box = screen.getByRole('checkbox', { name: /memory/i }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.getByTestId('scoped-ops-memory')).toHaveTextContent('ops: create, search');
  });

  it('keeps op-scoped entries byte-for-byte when an unrelated tool is toggled and saved', async () => {
    const onSave = vi.fn(async () => {});
    render(<ToolAccessEditor value={scoped} tools={tools} onSave={onSave} autosave />);

    fireEvent.click(screen.getByRole('checkbox', { name: /get doc/i }));
    await advance(500);

    expect(onSave).toHaveBeenCalledWith({
      mode: 'allow_list',
      allowList: ['memory_save', 'memory_search', 'get_doc'],
      denyList: [],
    });
  });

  it('drops the label when a tool-wide entry also covers the merged tool', () => {
    render(
      <ToolAccessEditor
        value={{ ...scoped, allowList: [...scoped.allowList, 'memory'] }}
        tools={tools}
        onSave={vi.fn()}
      />
    );
    expect(screen.queryByTestId('scoped-ops-memory')).toBeNull();
  });

  it('clears every entry for the merged tool, scoped ones included, when unchecked', async () => {
    const onSave = vi.fn(async () => {});
    render(<ToolAccessEditor value={scoped} tools={tools} onSave={onSave} autosave />);

    fireEvent.click(screen.getByRole('checkbox', { name: /memory/i }));
    await advance(500);

    expect(onSave).toHaveBeenCalledWith({ mode: 'allow_list', allowList: [], denyList: [] });
  });
});
