import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultCursorSpec,
  generateColors,
  generateShape,
  type CursorSpec,
} from '@snaglet/shared/cursor';

const list = vi.hoisted(() => vi.fn());
vi.mock('@desktop/utils/api', () => ({ agentsApi: { list } }));
vi.mock('@desktop/ws/useWs', () => ({
  useWs: () => ({
    addMessageListener: () => () => undefined,
    subscribe: () => undefined,
    unsubscribe: () => undefined,
    connectionState: 'closed',
  }),
}));

import { buildSavedSpecs, resetAgentSpecCache, resolveSpec, useAgentSpecs } from './useAgentSpecs';

const saved: CursorSpec = { v: 1, shape: generateShape(7), colors: generateColors(9) };

beforeEach(() => {
  list.mockReset();
  resetAgentSpecCache();
});

describe('pure helpers', () => {
  it('keeps only agents with a saved spec', () => {
    const map = buildSavedSpecs([
      { id: 'a', cursorSpec: saved },
      { id: 'b', cursorSpec: null },
      { id: 'c' },
    ]);
    expect([...map.keys()]).toEqual(['a']);
  });
  it('falls back to the id-derived default', () => {
    const map = buildSavedSpecs([{ id: 'a', cursorSpec: saved }]);
    expect(resolveSpec(map, 'a')).toBe(saved);
    expect(resolveSpec(map, 'z')).toEqual(defaultCursorSpec('z'));
  });
});

describe('useAgentSpecs', () => {
  it('returns the default while loading, then the saved spec', async () => {
    list.mockResolvedValue([{ id: 'ivy', cursorSpec: saved }]);
    const { result } = renderHook(() => useAgentSpecs());
    expect(result.current.specFor('ivy')).toEqual(defaultCursorSpec('ivy'));
    await waitFor(() => expect(result.current.specFor('ivy')).toBe(saved));
  });
  it('fails quietly and keeps defaults', async () => {
    list.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => useAgentSpecs());
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(result.current.specFor('ivy')).toEqual(defaultCursorSpec('ivy'));
  });
});
