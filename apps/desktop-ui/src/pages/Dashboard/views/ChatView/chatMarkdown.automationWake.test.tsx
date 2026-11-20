/**
 * An automation's wake posts `[automation <name>] @<Agent> <prompt>` into its
 * thread (AutomationService.postPrompt), with the prompt as the New / Edit
 * automation chip editor stored it. A user message renders through
 * `markdownForChatMessageRender` + MarkdownRenderer (MessageRow), so the
 * prompt's chips must come out as chips there, like a composer message's.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DashboardNavigationProvider } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { MarkdownRenderer } from '@desktop/features/rich-markdown/renderer/MarkdownRenderer';
import { markdownForChatMessageRender } from './chatMarkdown';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    agentsApi: {
      ...actual.agentsApi,
      list: async () => [
        { id: 'test-agent-a', name: 'Test Agent A' },
        { id: 'test-agent-b', name: 'Test Agent B' },
      ],
    },
  };
});

const DOC_ID = 'doc-1111111111111-aaaaaaaaa';
const THREAD_ID = 'thread-1111111111111-aaaaaaaaa';

/** What the chip editor stores for a two-line prompt with a mention and two links. */
const PROMPT = `Ask @Test Agent B about [Plan](${DOC_ID})\nthen post in [Test thread](${THREAD_ID}).`;
const WAKE = `[automation Morning check] @Test Agent A ${PROMPT}`;

describe('an automation wake message in the chat view', () => {
  it('renders the prompt chips, the woken agent and the label', async () => {
    const { container } = render(
      <DashboardNavigationProvider
        value={{ openInPane: vi.fn(), openThreadAgent: vi.fn(), requestReveal: vi.fn() }}
      >
        <MarkdownRenderer content={markdownForChatMessageRender(WAKE)} />
      </DashboardNavigationProvider>
    );

    expect(screen.getByText(/\[automation Morning check\]/)).toBeInTheDocument();
    const doc = container.querySelector(`[data-node-kind="doc"][data-node-url="${DOC_ID}"]`);
    expect(doc).toHaveTextContent('Plan');
    const thread = container.querySelector(
      `[data-node-kind="thread"][data-node-url="${THREAD_ID}"]`
    );
    expect(thread).toHaveTextContent('Test thread');
    // Agent mentions chip once the roster loads.
    await waitFor(() =>
      expect(container.querySelectorAll('[data-node-kind="agent"]')).toHaveLength(2)
    );
    expect(container.querySelector('[data-node-url="test-agent-a"]')).toHaveTextContent(
      'Test Agent A'
    );
    // The prompt's line break survives as a break, not a run-on line.
    expect(container.querySelector('br')).toBeInTheDocument();
    expect(container.textContent).not.toContain('](');
  });
});
