import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@desktop/utils/api/automations', () => ({ automationsApi: { list: vi.fn() } }));

import { StatusBar, StatusBarProvider } from '@desktop/components/StatusBar';
import {
  DashboardNavigationProvider,
  type DashboardNavigationValue,
} from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { AutomationsRunningSlot } from './AutomationsRunningSlot';
import { __resetAutomationsStoreForTests, upsertAutomation } from './automationsStore';
import { automationRecord } from './testFixtures';

const idle = automationRecord({ id: 'automation-1', name: 'Morning check' });
const running = (over = {}) =>
  automationRecord({
    id: 'automation-2',
    name: 'Build watch',
    running: true,
    runningSince: new Date(Date.now() - 65_000).toISOString(),
    ...over,
  });

function renderSlot() {
  const nav: DashboardNavigationValue = {
    openInPane: vi.fn(),
    openThreadAgent: vi.fn(),
    requestReveal: vi.fn(),
    openAutomation: vi.fn(),
  };
  render(
    <DashboardNavigationProvider value={nav}>
      <StatusBarProvider>
        <AutomationsRunningSlot />
        <StatusBar />
      </StatusBarProvider>
    </DashboardNavigationProvider>
  );
  return nav;
}

describe('AutomationsRunningSlot', () => {
  beforeEach(() => {
    __resetAutomationsStoreForTests();
  });

  it('shows only while a wake runs, and leaves when it settles', () => {
    upsertAutomation(idle);
    renderSlot();
    expect(screen.queryByRole('button', { name: /automations? running/ })).toBeNull();

    act(() => upsertAutomation(running()));
    const trigger = screen.getByRole('button', { name: /^1 automation running$/ });
    expect(trigger.querySelector('[data-spinning] svg')).not.toBeNull();

    act(() => upsertAutomation(running({ id: 'automation-3', name: 'Inbox sweep' })));
    expect(screen.getByRole('button', { name: /^2 automations running$/ })).toBeInTheDocument();

    act(() => {
      upsertAutomation(running({ running: false, runningSince: null }));
      upsertAutomation(running({ id: 'automation-3', running: false, runningSince: null }));
    });
    expect(screen.queryByRole('button', { name: /automations? running/ })).toBeNull();
  });

  it('lists the running ones; a row opens that automation', () => {
    upsertAutomation(idle);
    upsertAutomation(running());
    const nav = renderSlot();

    fireEvent.click(screen.getByRole('button', { name: /^1 automation running$/ }));
    const list = screen.getByRole('list', { name: 'Automations running' });
    expect(list).toHaveTextContent('Build watch');
    expect(list).toHaveTextContent('Test Agent A in Test thread');
    expect(list).toHaveTextContent(/1m 0[5-7]s/);
    expect(list).not.toHaveTextContent('Morning check');

    fireEvent.click(screen.getByRole('button', { name: /Build watch/ }));
    expect(nav.openAutomation).toHaveBeenCalledWith('automation-2', 'Build watch');
  });
});
