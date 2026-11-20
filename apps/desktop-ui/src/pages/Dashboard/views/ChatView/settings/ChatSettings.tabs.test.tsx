/**
 * Which settings tabs a thread shows: a regular thread has five (its
 * project, prompt, notifications and conversation limits live under General,
 * section id `context`); a subagent's thread only Agents and Maintenance (Snaglet sets its limits itself, and nobody watches a helper thread
 * for a run-ended alert); a caller can narrow the set with `sections` (a DM's
 * home thread shows Agents and Maintenance).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

vi.mock('./ContextSection', () => ({ ContextSection: () => <div>context-body</div> }));
vi.mock('./RoutingSection', () => ({ RoutingSection: () => <div>routing-body</div> }));
vi.mock('./WorkingFolderSection', () => ({ WorkingFolderSection: () => <div>folder-body</div> }));
vi.mock('./AgentsSection', () => ({ AgentsSection: () => <div>agents-body</div> }));
vi.mock('./MaintenanceSection', () => ({ MaintenanceSection: () => <div>maintenance-body</div> }));

import { ChatSettings } from './ChatSettings';

describe('ChatSettings tabs', () => {
  it('Folder opens the working folder settings for the thread', () => {
    render(<ChatSettings threadId="thread-1" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Folder' }));
    expect(screen.getByText('folder-body')).toBeInTheDocument();
    expect(screen.queryByText('context-body')).not.toBeInTheDocument();
  });

  it('a regular thread shows General, Routing, Folder, Agents and Maintenance, and opens on General', () => {
    render(<ChatSettings threadId="thread-1" />);
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual(['General', 'Routing', 'Folder', 'Agents', 'Maintenance']);
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('context-body')).toBeInTheDocument();
  });

  it('has no Notifications or Context tab (both now live under General)', () => {
    render(<ChatSettings threadId="thread-1" />);
    expect(screen.queryByRole('tab', { name: 'Notifications' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Context' })).not.toBeInTheDocument();
  });

  it('General is reachable again after switching tabs', () => {
    render(<ChatSettings threadId="thread-1" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Routing' }));
    expect(screen.queryByText('context-body')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'General' }));
    expect(screen.getByText('context-body')).toBeInTheDocument();
  });

  it('a stored `notifications` section id falls back to General', () => {
    render(
      <ChatSettings threadId="thread-1" sections={['notifications', 'agents', 'maintenance']} />
    );
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual(['General', 'Agents', 'Maintenance']);
    expect(screen.getByText('context-body')).toBeInTheDocument();
  });

  it("a subagent's thread shows only Agents and Maintenance, and opens on Agents", () => {
    render(<ChatSettings threadId="thread-1" helperThread />);
    expect(screen.queryByRole('tab', { name: 'Routing' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Folder' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'General' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Agents' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Maintenance' })).toBeInTheDocument();
    expect(screen.getByText('agents-body')).toBeInTheDocument();
    expect(screen.queryByText('context-body')).not.toBeInTheDocument();
  });

  it('`sections` narrows the tabs and opens on the first one shown', () => {
    render(
      <ChatSettings
        threadId="thread-1"
        sections={['agents', 'maintenance']}
        onOpenTrim={vi.fn()}
        onClear={vi.fn()}
      />
    );
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual(['Agents', 'Maintenance']);
    expect(screen.getByText('agents-body')).toBeInTheDocument();
    expect(screen.queryByText('context-body')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Maintenance' }));
    expect(screen.getByText('maintenance-body')).toBeInTheDocument();
  });
});
