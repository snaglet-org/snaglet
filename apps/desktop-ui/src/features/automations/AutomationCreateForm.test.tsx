import type { Editor } from '@tiptap/core';
import { EditorView } from '@tiptap/pm/view';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetCalendarStoreForTests } from '@desktop/features/calendar/calendarStore';
import { NODE_CHIP_MIME, setActiveDragChip, type NodeChipData } from '@desktop/utils/nodeChip';
import {
  automationRecord,
  DEFAULT_CALENDAR_ID,
  TEST_THREAD_ID,
  testCalendars,
  WORK_CALENDAR_ID,
  stubEditorLayout,
} from './testFixtures';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

vi.mock('@desktop/hooks/useTieredSearch', () => ({
  useTieredSearch: () => ({
    instant: null,
    enriched: null,
    instantLoading: false,
    enrichmentLoading: false,
  }),
  stableMergeById: <T,>(instant: readonly T[], enriched: readonly T[]) => [...instant, ...enriched],
}));

const api = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@desktop/utils/api/automations', () => ({ automationsApi: api }));

const people = vi.hoisted(() => ({
  agents: vi.fn(),
  threads: vi.fn(),
  thread: vi.fn(),
  participants: vi.fn(),
}));
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    agentsApi: { ...actual.agentsApi, list: () => people.agents() },
    threadsApi: {
      ...actual.threadsApi,
      list: (agentId?: string) => people.threads(agentId),
      get: (id: string) => people.thread(id),
      listParticipants: (id: string) => people.participants(id),
    },
  };
});

import { AutomationCreateForm } from './AutomationCreateForm';

const OTHER_THREAD_ID = 'thread-2222222222222-bbbbbbbbb';
const DOC: NodeChipData = { id: 'doc-1111111111111-aaaaaaaaa', kind: 'doc', title: 'Plan' };
const DOC_MARKUP = `[Plan](${DOC.id})`;

const participant = (agentId: string) => ({
  id: `participant-${agentId}`,
  threadId: TEST_THREAD_ID,
  memberId: `member-${agentId}`,
  kind: 'agent' as const,
  agentId,
  role: 'member',
});

beforeAll(stubEditorLayout);

beforeEach(() => {
  __resetCalendarStoreForTests({ calendars: testCalendars() });
  Object.values(people).forEach((fn) => fn.mockReset());
  api.create.mockReset();
  people.agents.mockResolvedValue([
    { id: 'test-agent-a', name: 'Test Agent A', role: null },
    { id: 'test-agent-b', name: 'Test Agent B', role: null },
  ]);
  // Each agent is in exactly one thread: Test Agent A in Test thread.
  people.threads.mockImplementation(async (agentId: string) =>
    agentId === 'test-agent-a' ? [{ id: TEST_THREAD_ID, title: 'Test thread' }] : []
  );
  people.thread.mockImplementation(async (id: string) => ({
    id,
    title: id === TEST_THREAD_ID ? 'Test thread' : 'Other thread',
  }));
  people.participants.mockImplementation(async (id: string) =>
    id === TEST_THREAD_ID ? [participant('test-agent-a')] : [participant('test-agent-b')]
  );
  api.create.mockResolvedValue({ automation: automationRecord() });
  vi.spyOn(EditorView.prototype, 'posAtCoords').mockImplementation(function (this: EditorView) {
    return { pos: this.state.selection.from, inside: -1 };
  });
});

afterEach(async () => {
  await act(async () => cleanup());
  setActiveDragChip(null);
  vi.restoreAllMocks();
});

const editorOf = (input: HTMLElement) => (input as HTMLElement & { editor?: Editor }).editor;

function drop(element: HTMLElement, chip: NodeChipData) {
  const dataTransfer = {
    types: [NODE_CHIP_MIME],
    getData: (type: string) => (type === NODE_CHIP_MIME ? JSON.stringify(chip) : ''),
    dropEffect: 'copy',
    files: [],
  };
  fireEvent.drop(element, { dataTransfer, clientX: 0, clientY: 0 });
}

function paste(element: HTMLElement, text: string) {
  fireEvent.paste(element, {
    clipboardData: {
      types: ['text/plain'],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    },
  });
}

async function pickAgent(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('textbox', { name: 'Agent' }));
  await user.keyboard(name);
  fireEvent.mouseDown(await screen.findByRole('option', { name: new RegExp(name) }));
  await waitFor(() =>
    expect(
      screen.getByRole('textbox', { name: 'Agent' }).querySelector('[data-node-kind="agent"]')
    ).toHaveTextContent(name)
  );
}

async function pickCalendar(from: string, to: string) {
  fireEvent.click(screen.getByRole('button', { name: `Calendar: ${from}` }));
  const list = await screen.findByRole('listbox', { name: 'Calendar' });
  fireEvent.click(within(list).getByRole('option', { name: to }));
  expect(screen.getByRole('button', { name: `Calendar: ${to}` })).toBeInTheDocument();
}

/** Agent (its only thread fills in), name and prompt: all but the timing. */
async function fillWhoAndWhat(user: ReturnType<typeof userEvent.setup>, prompt: HTMLElement) {
  await pickAgent(user, 'Test Agent A');
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Standup' } });
  await user.click(prompt);
  await user.keyboard('Post the notes.');
}

function renderForm() {
  const onCreated = vi.fn();
  render(<AutomationCreateForm onCreated={onCreated} />);
  const form = screen.getByRole('form', { name: 'New automation' });
  return {
    onCreated,
    create: within(form).getByRole('button', { name: 'Create automation' }),
    thread: within(form).getByRole('textbox', { name: 'Thread' }),
    prompt: within(form).getByRole('textbox', { name: 'Prompt' }),
  };
}

describe('AutomationCreateForm', () => {
  it('saves the prompt as chip markup, mentions and dropped nodes alike', async () => {
    const user = userEvent.setup();
    const { create, thread, prompt, onCreated } = renderForm();
    expect(create).toBeDisabled();

    await pickAgent(user, 'Test Agent A');
    // The agent's only thread is filled in.
    await waitFor(() =>
      expect(thread.querySelector('[data-node-kind="thread"]')).toHaveTextContent('Test thread')
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Standup' } });

    await user.click(prompt);
    await user.keyboard('Ask @Test Agent B');
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Test Agent B/ }));
    await waitFor(() => expect(prompt.querySelector('[data-node-kind="agent"]')).toBeTruthy());
    drop(prompt, DOC);
    await waitFor(() => expect(prompt.querySelector('[data-node-kind="doc"]')).toBeTruthy());

    fireEvent.click(screen.getByRole('radio', { name: 'Every' }));
    fireEvent.change(screen.getByLabelText('How many'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'm' } });
    await waitFor(() => expect(create).not.toBeDisabled());
    fireEvent.click(create);

    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({
        name: 'Standup',
        prompt: `Ask @Test Agent B ${DOC_MARKUP}`,
        when: { every: '30m', tz: expect.any(String) },
        agentId: 'test-agent-a',
        threadId: TEST_THREAD_ID,
        calendarId: DEFAULT_CALENDAR_ID,
      })
    );
    expect(people.participants).toHaveBeenCalledWith(TEST_THREAD_ID);
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it("says the agent isn't in the chosen thread, and re-checks when the agent changes", async () => {
    const user = userEvent.setup();
    const { create, thread, prompt } = renderForm();
    await pickAgent(user, 'Test Agent A');
    await waitFor(() => expect(thread.querySelector('[data-node-kind="thread"]')).toBeTruthy());

    // Swap in another thread by its id: Test Agent A is not in it.
    act(() => {
      editorOf(thread)?.commands.setNodeSelection(1);
    });
    await user.keyboard('{Backspace}');
    await user.click(thread);
    paste(thread, OTHER_THREAD_ID);
    expect(await screen.findByText("Test Agent A isn't in that thread.")).toBeInTheDocument();
    expect(thread).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Standup' } });
    await user.click(prompt);
    await user.keyboard('Post the notes.');
    expect(create).toBeDisabled();

    // Test Agent B is in that thread.
    const agent = screen.getByRole('textbox', { name: 'Agent' });
    // Keyboard input targets the focused field, not the editor selection.
    await user.click(agent);
    act(() => {
      editorOf(agent)?.commands.setNodeSelection(1);
    });
    expect(agent).toHaveFocus();
    await user.keyboard('{Backspace}');
    expect(agent.querySelector('[data-node-kind="agent"]')).toBeNull();
    await pickAgent(user, 'Test Agent B');
    await waitFor(() => expect(screen.queryByText(/isn't in that thread/)).not.toBeInTheDocument());
    expect(people.participants).toHaveBeenLastCalledWith(OTHER_THREAD_ID);
    await waitFor(() => expect(create).not.toBeDisabled());
  });

  it("swaps the thread it filled in when the agent changes, so it never names the old agent's", async () => {
    people.threads.mockImplementation(async (agentId: string) =>
      agentId === 'test-agent-a'
        ? [{ id: TEST_THREAD_ID, title: 'Test thread' }]
        : agentId === 'test-agent-b'
          ? [{ id: OTHER_THREAD_ID, title: 'Other thread' }]
          : []
    );
    const user = userEvent.setup();
    const { thread } = renderForm();
    await pickAgent(user, 'Test Agent A');
    await waitFor(() =>
      expect(thread.querySelector('[data-node-kind="thread"]')).toHaveTextContent('Test thread')
    );

    const agent = screen.getByRole('textbox', { name: 'Agent' });
    // Keyboard input targets the focused field, not the editor selection.
    await user.click(agent);
    act(() => {
      editorOf(agent)?.commands.setNodeSelection(1);
    });
    expect(agent).toHaveFocus();
    await user.keyboard('{Backspace}');
    expect(agent.querySelector('[data-node-kind="agent"]')).toBeNull();
    await pickAgent(user, 'Test Agent B');

    await waitFor(() =>
      expect(thread.querySelector('[data-node-kind="thread"]')).toHaveTextContent('Other thread')
    );
    expect(screen.queryByText(/isn't in that thread/)).not.toBeInTheDocument();
  });

  it('clears the thread it filled in when the next agent is in none', async () => {
    const user = userEvent.setup();
    const { thread } = renderForm();
    await pickAgent(user, 'Test Agent A');
    await waitFor(() => expect(thread.querySelector('[data-node-kind="thread"]')).toBeTruthy());

    const agent = screen.getByRole('textbox', { name: 'Agent' });
    // Keyboard input targets the focused field, not the editor selection.
    await user.click(agent);
    act(() => {
      editorOf(agent)?.commands.setNodeSelection(1);
    });
    expect(agent).toHaveFocus();
    await user.keyboard('{Backspace}');
    expect(agent.querySelector('[data-node-kind="agent"]')).toBeNull();
    await pickAgent(user, 'Test Agent B');

    expect(
      await screen.findByText("Test Agent B isn't in any thread yet. Add them to one first.")
    ).toBeInTheDocument();
    // The chip editor takes the cleared value on its next sync.
    await waitFor(() => expect(thread.querySelector('[data-node-kind="thread"]')).toBeNull());
  });

  it("says when the agent isn't in any thread yet", async () => {
    const user = userEvent.setup();
    renderForm();
    await pickAgent(user, 'Test Agent B');
    expect(
      await screen.findByText("Test Agent B isn't in any thread yet. Add them to one first.")
    ).toBeInTheDocument();
  });

  it('puts a once on the Default calendar when none is picked', async () => {
    const user = userEvent.setup();
    const { create, prompt } = renderForm();
    await fillWhoAndWhat(user, prompt);
    expect(screen.getByRole('button', { name: 'Calendar: Default calendar' })).toBeInTheDocument();
    await waitFor(() => expect(create).not.toBeDisabled());
    fireEvent.click(create);
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith(
        expect.objectContaining({
          when: { at: expect.any(String), tz: expect.any(String) },
          calendarId: DEFAULT_CALENDAR_ID,
        })
      )
    );
  });

  it('saves the picked calendar whatever the timing, Every included', async () => {
    const user = userEvent.setup();
    const { create, prompt } = renderForm();
    await fillWhoAndWhat(user, prompt);
    await pickCalendar('Default calendar', 'Work');

    fireEvent.click(screen.getByRole('radio', { name: 'Every' }));
    expect(screen.getByRole('button', { name: 'Calendar: Work' })).toBeInTheDocument();
    expect(screen.queryByText(/don't show on a calendar/)).toBeNull();
    await waitFor(() => expect(create).not.toBeDisabled());
    fireEvent.click(create);
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith(
        expect.objectContaining({
          when: expect.objectContaining({ every: '1h' }),
          calendarId: WORK_CALENDAR_ID,
        })
      )
    );
  });

  it('puts an Every on the Default calendar when none is picked', async () => {
    const user = userEvent.setup();
    const { create, prompt } = renderForm();
    await fillWhoAndWhat(user, prompt);
    fireEvent.click(screen.getByRole('radio', { name: 'Every' }));
    expect(screen.getByRole('button', { name: 'Calendar: Default calendar' })).toBeInTheDocument();
    await waitFor(() => expect(create).not.toBeDisabled());
    fireEvent.click(create);
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith(
        expect.objectContaining({
          when: expect.objectContaining({ every: '1h' }),
          calendarId: DEFAULT_CALENDAR_ID,
        })
      )
    );
  });

  it('offers No calendar first, muted and without a dot, and saves it as none', async () => {
    const user = userEvent.setup();
    const { create, prompt } = renderForm();
    await fillWhoAndWhat(user, prompt);
    fireEvent.click(screen.getByRole('button', { name: 'Calendar: Default calendar' }));
    const list = await screen.findByRole('listbox', { name: 'Calendar' });
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['No calendar', 'Default calendar', 'Work']);
    const none = within(list).getByRole('option', { name: 'No calendar' });
    expect(none.querySelector('[data-cal-color]')).toBeNull();
    expect(within(none).getByText('No calendar').className).toMatch(/selectMuted/);
    fireEvent.click(none);
    expect(screen.getByRole('button', { name: 'Calendar: No calendar' })).toBeInTheDocument();

    await waitFor(() => expect(create).not.toBeDisabled());
    fireEvent.click(create);
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith(
        expect.objectContaining({
          when: { at: expect.any(String), tz: expect.any(String) },
          calendarId: null,
        })
      )
    );
  });

  it('counts the stored markup against the 4000 limit', async () => {
    const user = userEvent.setup();
    const { prompt, create } = renderForm();
    expect(screen.getByText('0 / 4000')).toBeInTheDocument();

    drop(prompt, DOC);
    // The chip shows "Plan" but is stored, and counted, as its markup.
    expect(await screen.findByText(`${DOC_MARKUP.length} / 4000`)).toBeInTheDocument();

    await user.click(prompt);
    paste(prompt, 'x'.repeat(4000));
    expect(await screen.findByText(`${4000 + DOC_MARKUP.length} / 4000`)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      `Too long: ${4000 + DOC_MARKUP.length} of 4000 characters.`
    );
    expect(prompt).toHaveAttribute('aria-invalid', 'true');
    expect(create).toBeDisabled();
  });
});
