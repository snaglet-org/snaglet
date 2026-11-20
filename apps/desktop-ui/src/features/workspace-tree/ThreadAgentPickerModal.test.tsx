/**
 * ThreadAgentPickerModal — keyboard activation.
 *
 * Each agent row is a tab stop that toggles its selection on Space/Enter, and
 * it also contains a separately-focusable checkbox. This pins that a Space
 * press toggles the agent exactly once on both focus paths:
 *   - row focused  → the row's own keydown handler toggles;
 *   - checkbox focused → the checkbox owns its activation and the row handler
 *     must stay out of it, or the two toggles cancel and nothing changes.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ThreadAgentPickerModal drags in the real API barrel (via @desktop/components),
// whose config module throws at import time if these are unset. Stub them in a
// hoisted block so they exist before the static imports below run — same
// pattern as CreateMenu.test.tsx.
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { ThreadAgentPickerModal } from './ThreadAgentPickerModal';
import { agentsApi } from '@desktop/utils/api';
import type { SnagletAgent } from '@snaglet/shared/types';

vi.mock('@desktop/utils/api', () => ({
  agentsApi: {
    list: vi.fn(),
  },
}));

const listAgents = vi.mocked(agentsApi.list);

function agent(id: string, name: string): SnagletAgent {
  return { id, name } as unknown as SnagletAgent;
}

function renderModal() {
  const onCancel = vi.fn();
  const onCreate = vi.fn();
  render(
    <ThreadAgentPickerModal threadTitle="New thread" onCancel={onCancel} onCreate={onCreate} />
  );
  return { onCancel, onCreate };
}

beforeEach(() => {
  listAgents.mockReset();
  listAgents.mockResolvedValue([agent('a1', 'Alpha')]);
});

describe('ThreadAgentPickerModal keyboard toggle', () => {
  it('toggles selection when the row itself is focused (Space)', async () => {
    const user = userEvent.setup();
    renderModal();

    const row = await screen.findByRole('option', { name: /Alpha/i });
    row.focus();

    await user.keyboard(' ');
    expect(row).toHaveAttribute('aria-selected', 'true');

    await user.keyboard(' ');
    expect(row).toHaveAttribute('aria-selected', 'false');
  });

  it('toggles selection when the row itself is focused (Enter)', async () => {
    const user = userEvent.setup();
    renderModal();

    const row = await screen.findByRole('option', { name: /Alpha/i });
    row.focus();

    await user.keyboard('{Enter}');
    expect(row).toHaveAttribute('aria-selected', 'true');
  });

  it('leaves a checkbox-originated Space to the checkbox — the row handler stays inert', async () => {
    renderModal();

    const row = await screen.findByRole('option', { name: /Alpha/i });
    const checkbox = screen.getByRole('checkbox', { name: /Alpha/i });

    // A Space keydown whose target is the checkbox must pass straight through
    // the row: the handler neither toggles nor preventDefaults, leaving the
    // checkbox to own its single native activation. Without the guard the row
    // would call preventDefault (killing that native toggle) and run its own
    // toggle — the double-fire that net-cancels. `fireEvent` returns false
    // when a handler called preventDefault, so `notPrevented` pins that the
    // row kept its hands off.
    const notPrevented = fireEvent.keyDown(checkbox, { key: ' ', code: 'Space' });
    expect(notPrevented).toBe(true);
    // The row's own toggle did not run (fireEvent doesn't drive the checkbox's
    // native change, so any selection here would be the row mis-firing).
    expect(row).toHaveAttribute('aria-selected', 'false');
  });
});
