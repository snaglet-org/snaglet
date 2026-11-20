import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@desktop/utils/api/automations', () => ({ automationsApi: api }));

import { WebSocketContext, type WsContextValue } from '@desktop/ws/WebSocketContext';
import {
  __resetAutomationsStoreForTests,
  loadAutomations,
  upsertAutomation,
  useAutomations,
  useAutomationsFeed,
} from './automationsStore';
import { automationRecord } from './testFixtures';

function socket(connectionState: WsContextValue['connectionState']): WsContextValue {
  return {
    connectionState,
    serverRestarting: false,
    send: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    addMessageListener: () => () => undefined,
  };
}

describe('automationsStore', () => {
  beforeEach(() => {
    __resetAutomationsStoreForTests();
    api.list.mockReset();
  });

  it('folds a burst of reloads into one more read that sees the newest state', async () => {
    let release!: () => void;
    api.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ automations: [] });
        })
    );
    api.list.mockResolvedValue({ automations: [automationRecord({ name: 'Newest' })] });
    const { result } = renderHook(() => useAutomations());

    const first = loadAutomations();
    void loadAutomations();
    void loadAutomations();
    await act(async () => {
      release();
      await first;
    });

    expect(api.list).toHaveBeenCalledTimes(2);
    expect(result.current.automations?.map((a) => a.name)).toEqual(['Newest']);
  });

  it('does not let a read that started before a write put back the old record', async () => {
    let release!: () => void;
    api.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ automations: [automationRecord({ status: 'active' })] });
        })
    );
    api.list.mockResolvedValue({ automations: [automationRecord({ status: 'paused' })] });
    const { result } = renderHook(() => useAutomations());

    const read = loadAutomations();
    act(() => upsertAutomation(automationRecord({ status: 'paused' })));
    await act(async () => {
      release();
      await read;
    });

    // The stale page was dropped and read again; it never showed.
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(result.current.automations?.map((a) => a.status)).toEqual(['paused']);
  });

  it('re-reads when the socket comes back, since events sent meanwhile are lost', async () => {
    api.list.mockResolvedValue({ automations: [] });
    let ws = socket('open');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <WebSocketContext.Provider value={ws}>{children}</WebSocketContext.Provider>
    );
    const { rerender } = renderHook(() => useAutomationsFeed(), { wrapper });
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));

    ws = socket('closed');
    rerender();
    ws = socket('open');
    rerender();
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });
});
