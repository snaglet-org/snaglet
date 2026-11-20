/**
 * WikiLinkPreviewModal — a memory preview shows one plain metadata line
 * (`<agent> · from <thread> · <date>`) above the memory body: the chips carry
 * the agent's name and the thread's title, there are no boxed label/value
 * rows, and the key is not repeated (it is already the preview's title).
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryDetailRecord } from '@desktop/utils/api';
import { WikiLinkPreviewModal } from './WikiLinkPreviewModal';

const api = vi.hoisted(() => ({ getById: vi.fn(), getAgent: vi.fn() }));
vi.mock('@desktop/utils/api', async (original) => {
  const actual = await original<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    memoriesApi: { getById: api.getById },
    agentsApi: { ...actual.agentsApi, get: api.getAgent },
  };
});
vi.mock('@desktop/pages/Dashboard/views/AgentView', () => ({
  AgentView: ({ agent }: { agent: { id: string } }) => (
    <div data-testid="agent-view">{agent.id}</div>
  ),
}));
vi.mock('@desktop/features/rich-markdown/renderer/useWorkspaceAncestors', () => ({
  useWorkspaceAncestors: () => [],
}));
vi.mock('@desktop/features/rich-markdown/markdown-toggle-view', () => ({
  MarkdownToggleView: ({ content }: { content: string }) => (
    <div data-testid="memory-body">{content}</div>
  ),
}));

const MEMORY_ID = 'memory-1111111111111-aaaaaaaaa';
const AGENT_ID = 'test-agent-a';
const THREAD_ID = 'thread-1111111111111-aaaaaaaaa';
const CREATED_AT = '2026-01-15T18:24:00.000Z';

function memory(overrides: Partial<MemoryDetailRecord> = {}): MemoryDetailRecord {
  return {
    id: MEMORY_ID,
    agentId: AGENT_ID,
    memberId: null,
    agentName: 'Test Agent A',
    key: 'test-memory-key',
    content: 'Test memory content.',
    sourceThreadId: THREAD_ID,
    sourceThreadTitle: 'Test thread',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

async function renderPreview(record: MemoryDetailRecord) {
  api.getById.mockResolvedValue(record);
  render(<WikiLinkPreviewModal kind="memory" id={record.id} onClose={() => {}} />);
  return screen.findByTestId('memory-preview-meta');
}

function chip(line: HTMLElement, kind: string): HTMLElement {
  const found = line.querySelector<HTMLElement>(`.md-chip[data-node-kind="${kind}"]`);
  if (!found) throw new Error(`no ${kind} chip in the meta line`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('WikiLinkPreviewModal memory preview', () => {
  it('names the agent and the source thread in one plain metadata line', async () => {
    const line = await renderPreview(memory());

    const agent = chip(line, 'agent');
    expect(agent).toHaveAttribute('data-node-id', AGENT_ID);
    expect(within(agent).getByText('Test Agent A')).toBeInTheDocument();

    const thread = chip(line, 'thread');
    expect(thread).toHaveAttribute('data-node-id', THREAD_ID);
    expect(within(thread).getByText('Test thread')).toBeInTheDocument();
    expect(line).toHaveTextContent(/from\s*Test thread/);

    const created = line.querySelector('time');
    expect(created).toHaveAttribute('dateTime', CREATED_AT);
    expect(created?.textContent).toMatch(/2026/);

    expect(screen.getByTestId('memory-body')).toHaveTextContent('Test memory content.');
  });

  it('draws no label/value boxes and does not repeat the key', async () => {
    await renderPreview(memory());
    const body = screen.getByTestId('wiki-link-preview-body');

    for (const label of ['Agent', 'Source thread', 'Key', 'Created']) {
      expect(within(body).queryByText(label)).not.toBeInTheDocument();
    }
    // The key is the title bar, and only there.
    expect(screen.getAllByText('test-memory-key')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'test-memory-key' })).toBeInTheDocument();
  });

  it('opens the agent from its chip', async () => {
    api.getAgent.mockResolvedValue({ id: AGENT_ID, name: 'Test Agent A' });
    const line = await renderPreview(memory());

    fireEvent.click(within(chip(line, 'agent')).getByText('Test Agent A'));

    await waitFor(() => expect(api.getAgent).toHaveBeenCalledWith(AGENT_ID));
    expect(await screen.findByTestId('agent-view')).toHaveTextContent(AGENT_ID);
  });

  it('keeps the generic chip labels when the names did not resolve', async () => {
    const line = await renderPreview(memory({ agentName: null, sourceThreadTitle: null }));

    expect(within(chip(line, 'agent')).getByText('Agent')).toBeInTheDocument();
    expect(within(chip(line, 'thread')).getByText('Source thread')).toBeInTheDocument();
  });

  it('shows only the date when the memory has no agent or source thread', async () => {
    // A member-owned memory has no agent; one saved by hand has no thread.
    const line = await renderPreview(
      memory({
        agentId: null as unknown as string,
        agentName: null,
        sourceThreadId: null,
        sourceThreadTitle: null,
      })
    );

    expect(line.querySelector('.md-chip')).toBeNull();
    expect(line).not.toHaveTextContent('from');
    expect(line.querySelector('time')).toHaveAttribute('dateTime', CREATED_AT);
    expect(line).not.toHaveTextContent('·');
  });
});
