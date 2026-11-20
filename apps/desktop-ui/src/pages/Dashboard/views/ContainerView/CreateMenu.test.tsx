/**
 * CreateMenu — right-click "create" popover for ContainerView.
 *
 * Regression coverage for a silent no-op: choosing "New thread", naming it,
 * then finishing the flow in the agent-picker modal must create the thread.
 * The popover's outside-click dismiss effect reads a `ref` that goes `null`
 * the instant the component swaps to the 'agents' phase (which renders
 * ThreadAgentPickerModal instead of the `ref`'d div); if that counts as
 * "outside", every mousedown inside the modal — including on "Create thread"
 * itself — closes the whole menu before the click handler can run.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ThreadAgentPickerModal drags in the real API barrel (via @desktop/components),
// whose config module throws at import time if these are unset. Stub them in a
// hoisted block so they exist before the static imports below run — see
// CommandPalette.test.tsx for the same pattern.
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import CreateMenu from './CreateMenu';
import { agentsApi, containersApi, docsApi, threadsApi } from '@desktop/utils/api';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import type { SnagletAgent } from '@snaglet/shared/types';
import type { ThreadSummary } from '@desktop/utils/api';

vi.mock('@desktop/utils/api', () => ({
  containersApi: { create: vi.fn() },
  docsApi: { create: vi.fn() },
  threadsApi: { createInProjectWithAgents: vi.fn() },
  agentsApi: { list: vi.fn() },
}));

vi.mock('@desktop/utils/workspaceEvents', () => ({
  emitLibraryEvent: vi.fn(),
}));

vi.mock('@desktop/features/featureFlags/FeatureFlagsContext', () => ({
  useFeatureFlag: () => false,
}));

const AGENT: SnagletAgent = {
  id: 'agent-1',
  name: 'Agent One',
  role: 'assistant',
  provider: 'anthropic',
  modelId: 'model-x',
  systemPrompt: '',
  rawSystemPrompt: null,
  toolAccessMode: null,
  toolAccessAllowList: null,
  toolAccessDenyList: null,
  mcpServers: null,
  toolOverrides: null,
  maxToolCallsPerTurn: null,
  maxDurationSeconds: null,
  fallbacks: null,
  disableModelFallback: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  archived: false,
  archivedAt: null,
};

function renderMenu(parentCategory: 'project' | null = 'project') {
  const onClose = vi.fn();
  const onError = vi.fn();
  render(
    <CreateMenu
      x={10}
      y={10}
      parentContainerId="container-1111111111111-aaaaaaaaa"
      parentCategory={parentCategory}
      onClose={onClose}
      onError={onError}
    />
  );
  return { onClose, onError };
}

async function openThreadNamingStage(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'New thread' }));
  const input = screen.getByPlaceholderText('New thread');
  await user.clear(input);
  await user.type(input, 'My Thread');
  await user.keyboard('{Enter}');
}

const THREAD_ID = 'thread-1111111111111-aaaaaaaaa';
const PROJECT_ID = 'container-1111111111111-aaaaaaaaa';
const createdThread = { id: THREAD_ID, projectId: PROJECT_ID } as ThreadSummary;

beforeEach(() => {
  vi.mocked(agentsApi.list).mockResolvedValue([AGENT]);
  vi.mocked(threadsApi.createInProjectWithAgents)
    .mockReset()
    .mockResolvedValue({ thread: createdThread, failedAgentIds: [] });
  vi.mocked(emitLibraryEvent).mockReset();
  vi.mocked(containersApi.create).mockReset();
  vi.mocked(docsApi.create).mockReset();
});

describe('CreateMenu', () => {
  it('creates a container without a stray onClose beforehand', async () => {
    const user = userEvent.setup();
    const { onClose } = renderMenu();
    await user.click(screen.getByRole('button', { name: 'New container' }));
    const input = screen.getByPlaceholderText('New container');
    await user.clear(input);
    await user.type(input, 'My Container');
    await user.keyboard('{Enter}');
    expect(containersApi.create).toHaveBeenCalledWith({
      name: 'My Container',
      parentId: 'container-1111111111111-aaaaaaaaa',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('reaches the agent picker after naming a thread, and clicking inside it does not dismiss the menu', async () => {
    const user = userEvent.setup();
    const { onClose } = renderMenu();
    await openThreadNamingStage(user);

    // Agent picker is up.
    expect(await screen.findByText('Add agents to thread')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    // Clicking inside the modal (selecting an agent) must not count as an
    // outside click that closes the whole menu.
    await user.click(screen.getByRole('checkbox', { name: AGENT.name }));
    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByText('Add agents to thread')).toBeTruthy();
  });

  it('creates the thread in the project with the chosen agents and closes exactly once', async () => {
    const user = userEvent.setup();
    const { onClose } = renderMenu();
    await openThreadNamingStage(user);

    await user.click(await screen.findByRole('checkbox', { name: AGENT.name }));
    await user.click(screen.getByRole('button', { name: 'Create thread' }));

    expect(threadsApi.createInProjectWithAgents).toHaveBeenCalledWith('My Thread', PROJECT_ID, [
      AGENT.id,
    ]);
    expect(emitLibraryEvent).toHaveBeenCalledWith({ type: 'tree-invalidated', ids: [PROJECT_ID] });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes and reports the shortfall when the thread is created but an agent did not join', async () => {
    const user = userEvent.setup();
    vi.mocked(threadsApi.createInProjectWithAgents).mockResolvedValue({
      thread: createdThread,
      failedAgentIds: ['test-agent-b'],
    });
    const { onClose, onError } = renderMenu();
    await openThreadNamingStage(user);

    await user.click(await screen.findByRole('checkbox', { name: AGENT.name }));
    await user.click(screen.getByRole('button', { name: 'Create thread' }));

    // The thread exists, so the picker must not stay open offering a retry
    // that would create a duplicate; the tree still learns about the thread.
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/created without 1 agent\b/));
    expect(emitLibraryEvent).toHaveBeenCalledWith({ type: 'tree-invalidated', ids: [PROJECT_ID] });
  });

  it('reports a failed create and closes without invalidating the tree', async () => {
    const user = userEvent.setup();
    vi.mocked(threadsApi.createInProjectWithAgents).mockRejectedValue(
      new Error('Project not found')
    );
    const { onClose, onError } = renderMenu();
    await openThreadNamingStage(user);

    await user.click(await screen.findByRole('checkbox', { name: AGENT.name }));
    await user.click(screen.getByRole('button', { name: 'Create thread' }));

    expect(onError).toHaveBeenCalledWith('Project not found');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(emitLibraryEvent).not.toHaveBeenCalled();
  });

  it('creates a project inside a plain folder', async () => {
    const user = userEvent.setup();
    vi.mocked(containersApi.create).mockResolvedValue({
      id: 'container-2222222222222-bbbbbbbbb',
    } as Awaited<ReturnType<typeof containersApi.create>>);
    const { onClose, onError } = renderMenu(null);
    await user.click(screen.getByRole('button', { name: 'New project' }));
    const input = screen.getByPlaceholderText('New project');
    await user.clear(input);
    await user.type(input, 'My Project');
    await user.keyboard('{Enter}');
    expect(containersApi.create).toHaveBeenCalledWith({
      name: 'My Project',
      parentId: 'container-1111111111111-aaaaaaaaa',
      category: 'project',
    });
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not offer "New thread" inside a plain folder', () => {
    renderMenu(null);
    expect(screen.getByRole('button', { name: 'New doc' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New thread' })).toBeNull();
  });
});
