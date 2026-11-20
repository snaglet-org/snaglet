import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMcp } from './useMcp';

const api = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock('@desktop/utils/api', () => ({
  mcpServersApi: { list: api.list },
}));

vi.mock('@desktop/utils/mcpConnectionEvents', () => ({
  emitMcpConnectionEvent: vi.fn(),
}));

const server = (id: string) => ({ id, name: id, enabled: true }) as never;

describe('useMcp reload error banner', () => {
  beforeEach(() => {
    api.list.mockReset();
  });

  it('shows the error when a load fails', async () => {
    api.list.mockRejectedValue(new Error('server down'));
    const { result } = renderHook(() => useMcp());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('server down');
  });

  it('clears an old error banner when a later reload succeeds', async () => {
    api.list.mockRejectedValueOnce(new Error('server down'));
    api.list.mockResolvedValue([server('github')]);
    const { result } = renderHook(() => useMcp());
    await waitFor(() => expect(result.current.error).toBe('server down'));

    await act(() => result.current.reload());

    expect(result.current.servers).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('keeps showing the error when the later reload also fails', async () => {
    api.list.mockRejectedValueOnce(new Error('first failure'));
    api.list.mockRejectedValueOnce(new Error('second failure'));
    const { result } = renderHook(() => useMcp());
    await waitFor(() => expect(result.current.error).toBe('first failure'));

    await act(() => result.current.reload());

    expect(result.current.error).toBe('second failure');
  });
});
