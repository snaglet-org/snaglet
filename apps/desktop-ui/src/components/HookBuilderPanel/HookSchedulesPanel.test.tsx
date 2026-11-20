import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const schedulesApi = vi.hoisted(() => ({
  list: vi.fn(),
  setEnabled: vi.fn(),
  runNow: vi.fn(),
  runs: vi.fn(),
}));

vi.mock('@desktop/utils/api', () => ({ schedulesApi }));
vi.mock('@desktop/ws/useWs', () => ({ useWsChannel: () => ({ lastMessage: null }) }));

import { HookSchedulesPanel } from './HookSchedulesPanel';

describe('HookSchedulesPanel', () => {
  beforeEach(() => {
    Object.values(schedulesApi).forEach((fn) => fn.mockReset());
    schedulesApi.list.mockResolvedValue([]);
  });

  it('is operational status only; declarations belong in hook.ts', async () => {
    render(<HookSchedulesPanel hookName="daily-report" />);
    await screen.findByText(/no registered schedules/i);
    expect(screen.getByText(/add or change the `schedule` array/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create schedule/i })).not.toBeInTheDocument();
  });

  it('says it is loading until the first read lands, not that there are none', async () => {
    let release!: () => void;
    schedulesApi.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        })
    );
    render(<HookSchedulesPanel hookName="daily-report" />);
    expect(screen.getByText(/loading schedules/i)).toBeInTheDocument();
    expect(screen.queryByText(/no registered schedules/i)).not.toBeInTheDocument();
    release();
    await screen.findByText(/no registered schedules/i);
  });

  it('shows a failed read as an error only', async () => {
    schedulesApi.list.mockRejectedValue(new Error('scheduler offline'));
    render(<HookSchedulesPanel hookName="daily-report" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/scheduler offline/);
    await waitFor(() => expect(screen.queryByText(/loading schedules/i)).not.toBeInTheDocument());
    expect(screen.queryByText(/no registered schedules/i)).not.toBeInTheDocument();
  });

  it('lists only the schedules that fire this hook', async () => {
    const schedule = (id: string, actionKind: string, action: Record<string, unknown>) => ({
      id,
      name: id,
      enabled: true,
      scheduleKind: 'interval',
      schedule: { every: 1, unit: 'hour' },
      timezone: 'UTC',
      actionKind,
      action,
      nextRunAt: null,
      lastRunAt: null,
      lastStatus: null,
      createdAt: '2026-10-13T00:00:00.000Z',
      updatedAt: '2026-10-13T00:00:00.000Z',
    });
    schedulesApi.list.mockResolvedValue([
      schedule('mine', 'hook', { hookName: 'daily-report' }),
      schedule('other-hook', 'hook', { hookName: 'other-hook' }),
      schedule('an-automation', 'automation', { automationId: 'daily-report' }),
    ]);
    render(<HookSchedulesPanel hookName="daily-report" />);
    expect(await screen.findByText('mine')).toBeInTheDocument();
    expect(screen.queryByText('other-hook')).not.toBeInTheDocument();
    expect(screen.queryByText('an-automation')).not.toBeInTheDocument();
  });
});
