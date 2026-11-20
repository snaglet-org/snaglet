/**
 * ChatSettings: the Trim view is hosted inside Maintenance. The tabs stay
 * visible and usable, switching tabs or pressing Cancel leaves Trim (ChatView
 * stops dimming the thread), and every entry point lands on Maintenance so
 * Cancel returns there.
 *
 * The sections themselves are stubbed; only the orchestration is under test.
 * The trim panel is a stub too — its own Cancel / confirmation behavior is
 * covered in TrimPanel.test.tsx.
 */
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

vi.mock('./ContextSection.js', () => ({
  ContextSection: ({ onOpenTrim }: { onOpenTrim?: () => void }) => (
    <div>
      <p>stub-context</p>
      {onOpenTrim && <button onClick={onOpenTrim}>General trim now</button>}
    </div>
  ),
}));
vi.mock('./RoutingSection.js', () => ({ RoutingSection: () => <p>stub-routing</p> }));
vi.mock('./AgentsSection.js', () => ({ AgentsSection: () => <p>stub-agents</p> }));

import { ChatSettings } from './ChatSettings';

function Harness({ onClear = vi.fn() }: { onClear?: () => void }) {
  const [trimOpen, setTrimOpen] = useState(false);
  return (
    <>
      <output data-testid="trim-state">{trimOpen ? 'trim-open' : 'trim-closed'}</output>
      <ChatSettings
        threadId="thread-1"
        trimSummary="10 messages · 1 KB"
        onOpenTrim={() => setTrimOpen(true)}
        trimOpen={trimOpen}
        onCloseTrim={() => setTrimOpen(false)}
        trimPanel={
          <div data-testid="trim-panel">
            <button onClick={() => setTrimOpen(false)}>Cancel</button>
          </div>
        }
        onClear={onClear}
      />
    </>
  );
}

const tabs = () => screen.getByRole('tablist', { name: 'Settings sections' });
const tab = (name: string) => within(tabs()).getByRole('tab', { name });
const trimState = () => screen.getByTestId('trim-state').textContent;

describe('ChatSettings — hosted Trim view', () => {
  it('keeps every settings tab visible while Trim is open, with Maintenance selected', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(tab('Maintenance'));
    await user.click(screen.getByRole('button', { name: 'Trim now' }));

    expect(screen.getByTestId('trim-panel')).toBeInTheDocument();
    expect(trimState()).toBe('trim-open');
    for (const name of ['General', 'Routing', 'Agents', 'Maintenance']) {
      expect(tab(name)).toBeVisible();
    }
    expect(tab('Maintenance')).toHaveAttribute('aria-selected', 'true');
  });

  it('switches tabs from Trim without reopening Settings, and closes Trim', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(tab('Maintenance'));
    await user.click(screen.getByRole('button', { name: 'Trim now' }));
    await user.click(tab('Routing'));

    expect(screen.getByText('stub-routing')).toBeInTheDocument();
    expect(screen.queryByTestId('trim-panel')).toBeNull();
    expect(trimState()).toBe('trim-closed');

    // Coming back shows the Maintenance overview, not a lingering Trim view.
    await user.click(tab('Maintenance'));
    expect(screen.getByText('10 messages · 1 KB')).toBeInTheDocument();
    expect(screen.queryByTestId('trim-panel')).toBeNull();
  });

  it('returns to Maintenance on Cancel in the same Settings session', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(tab('Maintenance'));
    await user.click(screen.getByRole('button', { name: 'Trim now' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(trimState()).toBe('trim-closed');
    expect(screen.getByRole('button', { name: 'Trim now' })).toBeInTheDocument();
    expect(tab('Maintenance')).toHaveAttribute('aria-selected', 'true');
  });

  it('opens Trim from the General notice under Maintenance, so Cancel lands there', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(tab('General')).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('button', { name: 'General trim now' }));

    expect(screen.getByTestId('trim-panel')).toBeInTheDocument();
    expect(tab('Maintenance')).toHaveAttribute('aria-selected', 'true');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Trim now' })).toBeInTheDocument();
  });

  it('clicking the Maintenance tab itself leaves Trim for the overview', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(tab('Maintenance'));
    await user.click(screen.getByRole('button', { name: 'Trim now' }));
    await user.click(tab('Maintenance'));

    expect(trimState()).toBe('trim-closed');
    expect(screen.getByRole('button', { name: 'Trim now' })).toBeInTheDocument();
  });
});
