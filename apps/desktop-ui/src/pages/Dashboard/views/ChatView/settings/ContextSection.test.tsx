/**
 * ContextSection (the General tab) — the thread's project picker, the
 * closed-by-default "Thread system prompt" disclosure, and the Notifications
 * row. Project options come from the shared Options come from the shared
 * project list; the thread's own project is read from its record and
 * re-read on tree-shape events so the picker follows the thread. A change
 * applies optimistically through `threadsApi.setProject` and rolls back when
 * the server refuses.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerTreeNode } from '@desktop/utils/api';
import {
  emitLibraryEvent,
  onLibraryEvent,
  type LibraryEvent,
} from '@desktop/utils/workspaceEvents';
import { __resetProjectListForTests } from '@desktop/features/database/projectList';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({
  threads: {
    get: vi.fn(),
    listParticipants: vi.fn(),
    getContextUsage: vi.fn(),
    setProject: vi.fn(),
  },
  containers: { listTree: vi.fn() },
}));

vi.mock('@desktop/utils/api', async () => {
  const actual = await vi.importActual<typeof import('@desktop/utils/api')>('@desktop/utils/api');
  return {
    ...actual,
    threadsApi: api.threads,
    containersApi: { ...actual.containersApi, listTree: api.containers.listTree },
  };
});
vi.mock('@desktop/features/rich-markdown/workspace-editor/index.js', () => ({
  WorkspaceEditor: ({
    kind,
    saveMode,
    draftKey,
  }: {
    kind: string;
    saveMode?: string;
    draftKey?: string;
  }) => <div data-testid={`editor-${kind}`} data-save-mode={saveMode} data-draft-key={draftKey} />,
  EditorSaveHint: () => null,
  useEditorSaveStatus: () => ({
    status: { state: 'idle', error: null },
    onSaveStateChange: vi.fn(),
  }),
}));
vi.mock('./CompactAllAgentsPanel', () => ({ CompactAllAgentsPanel: () => null }));
// Has its own suite; mocked so its load (and any error it shows) stays out of these.
vi.mock('./ConversationLimits', () => ({ ConversationLimits: () => null }));
vi.mock('./NotificationsSection', () => ({
  NotificationsSection: ({ threadId }: { threadId: string }) => (
    <div data-testid="notifications-row" data-thread={threadId} />
  ),
}));

import { ContextSection } from './ContextSection';

const THREAD_ID = 'thread-1111111111111-aaaaaaaaa';
const OTHER_THREAD_ID = 'thread-2222222222222-bbbbbbbbb';
const PROJECT_A = 'container-1111111111111-aaaaaaaaa';
const PROJECT_B = 'container-2222222222222-bbbbbbbbb';
const PROJECT_NESTED = 'container-3333333333333-ccccccccc';
const FOLDER = 'container-4444444444444-ddddddddd';
const timestamp = '2026-01-01T00:00:00.000Z';

function container(
  id: string,
  name: string,
  category: ContainerTreeNode['category'],
  children: ContainerTreeNode['children'] = []
): ContainerTreeNode {
  return {
    kind: 'container',
    id,
    parentId: null,
    name,
    sortOrder: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    children,
    category,
    folderPath: null,
    githubUrl: null,
  };
}

/** The server's view of each thread's project; `setProject` writes here. */
let threadProjects: Record<string, string | null> = {};
let events: LibraryEvent[] = [];
let stop: () => void = () => undefined;

beforeEach(() => {
  __resetProjectListForTests();
  threadProjects = { [THREAD_ID]: PROJECT_A, [OTHER_THREAD_ID]: PROJECT_B };
  api.threads.get.mockReset().mockImplementation(async (id: string) => ({
    id,
    threadSystemPrompt: '',
    projectId: threadProjects[id] ?? null,
  }));
  api.threads.listParticipants.mockReset().mockResolvedValue([]);
  api.threads.getContextUsage.mockReset();
  api.threads.setProject.mockReset().mockImplementation(async (id: string, next: string | null) => {
    threadProjects[id] = next;
    return { id, projectId: next };
  });
  api.containers.listTree
    .mockReset()
    .mockResolvedValue([
      container(PROJECT_A, 'Project A', 'project'),
      container(PROJECT_B, 'Project B', 'project'),
      container(FOLDER, 'Archive', null, [container(PROJECT_NESTED, 'Nested', 'project')]),
    ]);
  events = [];
  stop = onLibraryEvent((event) => events.push(event));
});

afterEach(() => stop());

const select = async () => {
  const el = (await screen.findByLabelText('Thread project')) as HTMLSelectElement;
  await waitFor(() => expect(el).not.toBeDisabled());
  return el;
};

describe('ContextSection project picker', () => {
  it('shows the thread’s current project and every project (with lineage) plus "No project"', async () => {
    render(<ContextSection threadId={THREAD_ID} />);
    const el = await select();
    expect(el.value).toBe(PROJECT_A);
    expect(Array.from(el.options).map((o) => o.textContent)).toEqual([
      'No project',
      'Archive / Nested',
      'Project A',
      'Project B',
    ]);
    // The thread's project comes from its record, not from a tree scan.
    expect(api.threads.get).toHaveBeenCalledWith(THREAD_ID);
  });

  it('selects "No project" for a flat thread', async () => {
    threadProjects[THREAD_ID] = null;
    render(<ContextSection threadId={THREAD_ID} />);
    expect((await select()).value).toBe('');
  });

  it('moves the thread to the chosen project and notifies tree consumers', async () => {
    const user = userEvent.setup();
    render(<ContextSection threadId={THREAD_ID} />);
    const el = await select();

    await user.selectOptions(el, PROJECT_B);

    expect(api.threads.setProject).toHaveBeenCalledWith(THREAD_ID, PROJECT_B);
    await waitFor(() => expect(el.value).toBe(PROJECT_B));
    expect(events).toContainEqual({
      type: 'tree-invalidated',
      ids: [THREAD_ID, PROJECT_A, PROJECT_B],
    });
  });

  it('makes the thread flat when "No project" is chosen', async () => {
    const user = userEvent.setup();
    render(<ContextSection threadId={THREAD_ID} />);
    const el = await select();

    await user.selectOptions(el, '');

    expect(api.threads.setProject).toHaveBeenCalledWith(THREAD_ID, null);
    await waitFor(() => expect(el.value).toBe(''));
  });

  it('rolls back and shows the error when the move is refused', async () => {
    const user = userEvent.setup();
    api.threads.setProject.mockRejectedValue(new Error('project_id must be a project container'));
    render(<ContextSection threadId={THREAD_ID} />);
    const el = await select();

    await user.selectOptions(el, PROJECT_B);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'project_id must be a project container'
    );
    expect(el.value).toBe(PROJECT_A);
    expect(events).toEqual([]);
  });

  it('relabels when the thread is moved to another project elsewhere', async () => {
    render(<ContextSection threadId={THREAD_ID} />);
    const el = await select();
    expect(el.value).toBe(PROJECT_A);

    // A sidebar drag moved the thread: the server now reports Project B.
    threadProjects[THREAD_ID] = PROJECT_B;
    await act(async () =>
      emitLibraryEvent({ type: 'node-moved', kind: 'thread', id: THREAD_ID, parentId: PROJECT_B })
    );
    await waitFor(() => expect(el.value).toBe(PROJECT_B));
    expect(api.threads.setProject).not.toHaveBeenCalled();

    // Unrelated events do not re-read the thread.
    const reads = api.threads.get.mock.calls.length;
    await act(async () =>
      emitLibraryEvent({ type: 'doc-saved', id: 'doc-1111111111111-aaaaaaaaa', content: '' })
    );
    expect(api.threads.get).toHaveBeenCalledTimes(reads);
  });

  it('does not write a stale rollback into the next thread when the thread switches mid-save', async () => {
    const user = userEvent.setup();
    let reject: (err: Error) => void = () => undefined;
    api.threads.setProject.mockImplementation(
      () =>
        new Promise((_resolve, rej) => {
          reject = rej;
        })
    );
    const view = render(<ContextSection threadId={THREAD_ID} />);
    const el = await select();

    await user.selectOptions(el, PROJECT_NESTED);
    expect(api.threads.setProject).toHaveBeenCalledWith(THREAD_ID, PROJECT_NESTED);

    // The pane moves on to another thread while the save is still pending.
    view.rerender(<ContextSection threadId={OTHER_THREAD_ID} />);
    const next = await select();
    expect(next.value).toBe(PROJECT_B);

    await act(async () => reject(new Error('Project not found')));

    // The first thread's rollback (to Project A) and its error stay out of
    // the picker now showing the second thread.
    expect(next.value).toBe(PROJECT_B);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(next).not.toBeDisabled();
  });

  it('surfaces a project list load failure', async () => {
    api.containers.listTree.mockRejectedValue(new Error('HTTP 502'));
    render(<ContextSection threadId={THREAD_ID} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 502');
    expect(screen.getByLabelText('Thread project')).toBeDisabled();
  });
});

const promptToggle = (summary?: string) =>
  screen.findByRole('button', {
    name: summary ? `Thread system prompt, ${summary}` : /^Thread system prompt/,
  });

const openPrompt = async () => {
  const toggle = await promptToggle();
  await userEvent.click(toggle);
  return toggle;
};

describe('ContextSection thread system prompt', () => {
  it('replaces the loading hint with the error when the thread cannot load', async () => {
    api.threads.get.mockRejectedValue(new Error('thread unavailable'));
    render(<ContextSection threadId={THREAD_ID} />);
    await openPrompt();

    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    expect(screen.queryByTestId('editor-thread-system-prompt')).toBeNull();
    expect(
      screen.getAllByRole('alert').some((alert) => alert.textContent === 'thread unavailable')
    ).toBe(true);
  });
});

describe('ContextSection thread system prompt', () => {
  it('is a leaf disclosure, closed by default, that reveals the editor on open', async () => {
    render(<ContextSection threadId={THREAD_ID} />);
    const toggle = await promptToggle('None');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('editor-thread-system-prompt')).toBeNull();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByTestId('editor-thread-system-prompt')).toBeInTheDocument();
  });

  it('summarizes a saved prompt as custom instructions', async () => {
    api.threads.get.mockImplementation(async (id: string) => ({
      id,
      threadSystemPrompt: 'Be brief.',
      projectId: threadProjects[id] ?? null,
    }));
    render(<ContextSection threadId={THREAD_ID} />);
    expect(await promptToggle('Custom instructions')).toBeInTheDocument();
  });

  it('keeps the drag-to-link hint reachable while closed', async () => {
    render(<ContextSection threadId={THREAD_ID} />);
    await promptToggle();
    expect(
      screen.getByRole('button', { name: 'About the thread system prompt' })
    ).toBeInTheDocument();
  });

  it('uses explicit Save (no autosave) with a per-thread unsaved draft', async () => {
    render(<ContextSection threadId={THREAD_ID} />);
    await openPrompt();
    const editor = await screen.findByTestId('editor-thread-system-prompt');
    expect(editor).toHaveAttribute('data-save-mode', 'manual');
    expect(editor).toHaveAttribute(
      'data-draft-key',
      `snaglet:draft:thread-system-prompt:${THREAD_ID}`
    );
  });
});

describe('ContextSection notifications', () => {
  it('renders the Notifications row for this thread', async () => {
    render(<ContextSection threadId={THREAD_ID} />);
    expect(await screen.findByTestId('notifications-row')).toHaveAttribute(
      'data-thread',
      THREAD_ID
    );
  });
});

describe('ContextSection text size', () => {
  it('offers the thread’s text size, Small by default', async () => {
    render(<ContextSection threadId={THREAD_ID} />);
    const group = await screen.findByRole('radiogroup', { name: 'Text size' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Small' })).toHaveAttribute('aria-checked', 'true');
  });
});
