import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { NotificationRecord } from '@snaglet/shared/types';

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    notificationsApi: {
      ...actual.notificationsApi,
      markRead: vi.fn(async () => undefined),
      dismiss: vi.fn(async () => undefined),
    },
  };
});
vi.mock('@desktop/utils/appUpdate', () => ({ offerAppUpdate: vi.fn() }));

import {
  DashboardNavigationProvider,
  type DashboardNavigationValue,
} from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { notificationsApi } from '@desktop/utils/api';
import { offerAppUpdate } from '@desktop/utils/appUpdate';
import { NotificationPopover } from './NotificationPopover';

const THREAD_ID = 'thread-1111111111111-aaaaaaaaa';

const notice: NotificationRecord = {
  id: 'notification-1111111111111-aaaaaaaaa',
  type: 'automation',
  title: '"Morning check" paused after 3 failed runs',
  body: 'Last error: Provider exploded.',
  threadId: THREAD_ID,
  agentId: 'test-agent-a',
  runId: null,
  read: false,
  dismissed: false,
  createdAt: new Date().toISOString(),
};

describe('NotificationPopover', () => {
  it('opens the thread by id, never as an untitled stub that names the pane by its id', () => {
    const nav: DashboardNavigationValue = {
      openInPane: vi.fn(),
      openThreadAgent: vi.fn(),
      requestReveal: vi.fn(),
      openThread: vi.fn(),
    };
    const onClose = vi.fn();
    render(
      <DashboardNavigationProvider value={nav}>
        <NotificationPopover notifications={[notice]} onClose={onClose} />
      </DashboardNavigationProvider>
    );

    fireEvent.click(screen.getByText(notice.title));
    expect(nav.openThread).toHaveBeenCalledWith(THREAD_ID);
    expect(nav.openInPane).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the dismiss button beside the row button, not inside it', () => {
    const nav: DashboardNavigationValue = {
      openInPane: vi.fn(),
      openThreadAgent: vi.fn(),
      requestReveal: vi.fn(),
      openThread: vi.fn(),
    };
    const onClose = vi.fn();
    render(
      <DashboardNavigationProvider value={nav}>
        <NotificationPopover notifications={[notice]} onClose={onClose} />
      </DashboardNavigationProvider>
    );

    const dismiss = screen.getByRole('button', { name: 'Dismiss notification' });
    expect(dismiss.parentElement?.closest('button')).toBeNull();
    fireEvent.click(dismiss);
    expect(notificationsApi.dismiss).toHaveBeenCalledWith(notice.id);
    expect(nav.openThread).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers an install only from the update offer, not from other app_update notices', () => {
    const offer: NotificationRecord = {
      ...notice,
      id: 'notification-2222222222222-bbbbbbbbb',
      type: 'app_update',
      title: 'Snaglet v1.0.1 is available',
      body: 'You are on 1.0.0. Click to update.',
      threadId: null,
    };
    const folder: NotificationRecord = {
      ...offer,
      id: 'notification-3333333333333-ccccccccc',
      title: 'Notes folder moved',
      body: '/old → /new',
    };
    const onClose = vi.fn();
    render(<NotificationPopover notifications={[folder, offer]} onClose={onClose} />);

    fireEvent.click(screen.getByText(folder.title));
    expect(offerAppUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(offer.title));
    expect(offerAppUpdate).toHaveBeenCalledTimes(1);
    expect(offerAppUpdate).toHaveBeenCalledWith('v1.0.1');
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
