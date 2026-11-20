/**
 * MessageRow: the run-failure card. A no-model failure is titled "No model
 * configured" and links to the agent's page through the dashboard navigation;
 * a rendering without that navigation (a preview, an export) shows the text
 * alone. Other failures keep their titles and get no link.
 */
import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadMessage } from '@desktop/utils/api';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import {
  DashboardNavigationProvider,
  type DashboardNavigationValue,
} from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { MessageRow } from './MessageRow';

const SUMMARY = 'Pick a provider and model for Ada to answer.';

function errorRow(
  runError: NonNullable<ThreadMessage['runError']>,
  over: Partial<ThreadMessage> = {}
): ThreadMessage {
  return {
    id: 'msg-err',
    threadId: 'thread-1',
    role: 'assistant',
    agentId: 'test-agent-a',
    content: `⚠ ${runError.summary}`,
    createdAt: '2026-07-04T00:00:00.000Z',
    runError,
    ...over,
  };
}

const noModel = (over: Partial<ThreadMessage> = {}) =>
  errorRow({ kind: 'no_model', summary: SUMMARY, agentName: 'Ada' }, over);

function navValue(over: Partial<DashboardNavigationValue> = {}): DashboardNavigationValue {
  return {
    openInPane: vi.fn(),
    openThreadAgent: vi.fn(),
    requestReveal: vi.fn(),
    openAgentById: vi.fn(),
    ...over,
  };
}

function renderRow(message: ThreadMessage, nav: DashboardNavigationValue | null) {
  const row = <MessageRow message={message} agentNameById={new Map()} renderMode="raw" />;
  const wrap = (children: ReactNode) =>
    nav ? (
      <DashboardNavigationProvider value={nav}>{children}</DashboardNavigationProvider>
    ) : (
      children
    );
  return render(<>{wrap(row)}</>);
}

const configureLink = () => screen.queryByRole('button', { name: 'Configure model' });

describe('MessageRow — no-model run error', () => {
  it('is titled "No model configured" and keeps the summary line', () => {
    renderRow(noModel(), navValue());
    expect(screen.getByText(/Ada — No model configured/)).toBeTruthy();
    expect(screen.getByText(SUMMARY)).toBeTruthy();
    expect(screen.queryByText(/Run failed/)).toBeNull();
  });

  it("opens the agent's Overview tab from Configure model", () => {
    const openAgentById = vi.fn();
    renderRow(noModel(), navValue({ openAgentById }));

    const link = configureLink();
    expect(link).not.toBeNull();
    fireEvent.click(link!);

    expect(openAgentById).toHaveBeenCalledTimes(1);
    expect(openAgentById).toHaveBeenCalledWith('test-agent-a', { tab: 'overview' });
  });

  it('is a real button that takes keyboard focus', () => {
    renderRow(noModel(), navValue());
    const link = configureLink()!;
    expect(link.tagName).toBe('BUTTON');
    expect(link.getAttribute('type')).toBe('button');
    link.focus();
    expect(document.activeElement).toBe(link);
  });

  it('shows only the text where there is no dashboard navigation', () => {
    renderRow(noModel(), null);
    expect(screen.getByText(SUMMARY)).toBeTruthy();
    expect(configureLink()).toBeNull();
  });

  it('shows only the text when the navigation cannot open agents', () => {
    renderRow(noModel(), navValue({ openAgentById: undefined }));
    expect(screen.getByText(SUMMARY)).toBeTruthy();
    expect(configureLink()).toBeNull();
  });

  it('shows no link when the row names no agent', () => {
    renderRow(noModel({ agentId: null }), navValue());
    expect(configureLink()).toBeNull();
  });
});

describe('MessageRow — other run errors', () => {
  it.each([
    ['runtime', 'Run failed'],
    ['model_failure', 'Model error'],
    ['timeout', 'Response timed out'],
  ] as const)('a %s error keeps its title and has no Configure model link', (kind, title) => {
    renderRow(errorRow({ kind, summary: 'boom', agentName: 'Ada' }), navValue());
    expect(screen.getByText(new RegExp(`Ada — ${title}`))).toBeTruthy();
    expect(configureLink()).toBeNull();
  });
});
