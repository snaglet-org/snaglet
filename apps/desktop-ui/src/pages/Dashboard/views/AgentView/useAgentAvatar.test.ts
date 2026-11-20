import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { defaultCursorSpec, generateCursorSpec } from '@snaglet/shared/cursor';
import { useAgentAvatar } from './useAgentAvatar';

describe('useAgentAvatar', () => {
  it('starts from the id-derived default', () => {
    const { result } = renderHook(() =>
      useAgentAvatar({ agentId: 'test-agent-a', spec: null, onSave: vi.fn() })
    );
    expect(result.current.spec).toEqual(defaultCursorSpec('test-agent-a'));
    expect(result.current.error).toBe(false);
  });

  it('shuffle saves a new shape and new colors together and shows them at once', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useAgentAvatar({ agentId: 'test-agent-a', spec: null, onSave })
    );
    const before = result.current.spec;
    await act(async () => {
      await result.current.shuffle();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0].cursorSpec;
    expect(saved.v).toBe(1);
    expect(saved.shape).not.toEqual(before.shape);
    expect(saved.colors).toBeTruthy();
    expect(result.current.spec).toEqual(saved);
  });

  it('rolls back to the saved avatar when the save fails', async () => {
    const saved = generateCursorSpec(5, 9);
    const onSave = vi.fn().mockRejectedValue(new Error('nope'));
    const { result } = renderHook(() =>
      useAgentAvatar({ agentId: 'test-agent-a', spec: saved, onSave })
    );
    await act(async () => {
      await result.current.shuffle();
    });
    expect(result.current.spec).toEqual(saved);
    expect(result.current.error).toBe(true);
  });
});
