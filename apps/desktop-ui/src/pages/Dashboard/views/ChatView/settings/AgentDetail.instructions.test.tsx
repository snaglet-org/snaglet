/**
 * An agent's thread instructions in thread Settings, on the real editor. They
 * save the way the thread system prompt does: nothing is sent while typing,
 * Save (or Cmd/Ctrl+S) sends the draft, a trimmed save leaves the typed text
 * alone, a dropped doc goes into the draft, and each agent's unsaved draft
 * and saves stay with that agent, even when a save finishes after a switch.
 */
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Editor } from '@tiptap/core';
import { EditorView } from '@tiptap/pm/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnagletAgent } from '@snaglet/shared/types';
import type { ThreadParticipant } from '@desktop/utils/api';
import { NODE_CHIP_MIME, type NodeChipData } from '@desktop/utils/nodeChip/payload';

const api = vi.hoisted(() => ({
  threads: {
    listParticipants: vi.fn(),
    setParticipantModel: vi.fn(),
    removeParticipant: vi.fn(),
    updateParticipantOverrides: vi.fn(),
  },
  agentsList: vi.fn(),
  tablesList: vi.fn(),
  listProposed: vi.fn(),
}));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    threadsApi: api.threads,
    agentsApi: { ...actual.agentsApi, list: api.agentsList },
    tablesApi: { ...actual.tablesApi, list: api.tablesList },
    memoriesApi: { ...actual.memoriesApi, listProposed: api.listProposed },
  };
});
vi.mock('@desktop/hooks/useToolOptions.js', () => ({
  useToolOptions: () => [],
  toolAccessOf: () => ({ mode: 'all', allowList: [], denyList: [] }),
}));
vi.mock('@desktop/components/BudgetControl/BudgetControl.js', () => ({
  BudgetControl: () => null,
}));
vi.mock('@desktop/components/ToolAccessEditor/index.js', () => ({
  ToolAccessEditor: () => null,
}));
vi.mock('@desktop/components/AgentModelEditor/index.js', () => ({
  AgentModelEditor: () => null,
}));
vi.mock('@desktop/components/AgentConfigCard/index.js', () => ({
  ContextWindowPanel: () => null,
}));
vi.mock('@desktop/features/skills/index.js', () => ({
  ThreadSkillsSection: () => null,
}));
vi.mock('./ThreadUtilityModelOverride', () => ({
  ThreadUtilityModelOverride: () => null,
}));

import { AgentDetail } from './AgentDetail';
import { AgentsSection } from './AgentsSection';

const THREAD_ID = 'thread-1111111111111-aaaaaaaaa';
const DOC: NodeChipData = { id: 'doc-1111111111111-aaaaaaaaa', kind: 'doc', title: 'Doc A' };
/** Longer than the autosave debounce, so an autosaving editor would have sent by then. */
const PAST_AUTOSAVE_MS = 900;

function agent(over: Partial<SnagletAgent> & Pick<SnagletAgent, 'id' | 'name'>): SnagletAgent {
  return {
    provider: 'provider-a',
    modelId: 'model-a',
    credentialId: null,
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
    ...over,
  };
}

function participant(
  agentId: string,
  systemPromptAddendum: string | null = null
): ThreadParticipant {
  return {
    id: `participant-${agentId}`,
    threadId: THREAD_ID,
    memberId: `member-${agentId}`,
    kind: 'agent',
    agentId,
    role: 'assistant',
    credentialId: null,
    providerId: null,
    modelId: null,
    addedAt: '2026-01-01T00:00:00.000Z',
    systemPromptAddendum,
    toolAccessMode: null,
    toolAccessAllowList: null,
    toolAccessDenyList: null,
    toolOverrides: null,
    maxToolCallsPerTurn: null,
    maxDurationSeconds: null,
    autoRespond: true,
    disableFallback: false,
  };
}

const AGENT_A = agent({ id: 'test-agent-a', name: 'Test Agent A' });
const AGENT_B = agent({ id: 'test-agent-b', name: 'Test Agent B' });
const HELPER = agent({
  id: 'subagent-11111111-1111-4111-8111-111111111111',
  name: 'Test Helper',
  role: 'subagent',
  parentAgentId: AGENT_A.id,
});

function Harness({ agent: shown, initial }: { agent: SnagletAgent; initial: ThreadParticipant }) {
  const [rows, setRows] = useState<Record<string, ThreadParticipant>>({});
  const row = rows[initial.agentId] ?? initial;
  return (
    <AgentDetail
      entry={{ participant: row, agent: shown }}
      threadId={THREAD_ID}
      onParticipantUpdated={(next) => setRows((prev) => ({ ...prev, [next.agentId]: next }))}
      onParticipantRemoved={vi.fn()}
    />
  );
}

const editorOf = (input: HTMLElement): Editor => (input as HTMLElement & { editor: Editor }).editor;

async function openInstructions(label: RegExp = /Thread instructions/): Promise<HTMLElement> {
  const toggle = screen.getByRole('button', { name: label });
  if (toggle.getAttribute('aria-expanded') !== 'true') await userEvent.click(toggle);
  return screen.findByRole('textbox', { name: 'Agent thread instructions' });
}

/** Types at the end of the instructions, the way a keystroke reaches the editor. */
function typeAtEnd(input: HTMLElement, text: string) {
  act(() => {
    editorOf(input).chain().focus('end').insertContent(text).run();
  });
}

function dropDoc(input: HTMLElement, chip: NodeChipData) {
  const dataTransfer = {
    types: [NODE_CHIP_MIME],
    getData: (type: string) => (type === NODE_CHIP_MIME ? JSON.stringify(chip) : ''),
    dropEffect: 'copy',
    files: [],
  };
  fireEvent.drop(input, { dataTransfer, clientX: 0, clientY: 0 });
}

const pause = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

beforeAll(() => {
  if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () => new DOMRect();
});

beforeEach(() => {
  localStorage.clear();
  for (const fn of Object.values(api.threads)) fn.mockReset();
  api.agentsList.mockReset().mockResolvedValue([]);
  api.tablesList.mockReset().mockResolvedValue({ tables: [] });
  api.listProposed.mockReset().mockResolvedValue([]);
  api.threads.updateParticipantOverrides.mockImplementation(
    async (_threadId: string, agentId: string, patch: Partial<ThreadParticipant>) => ({
      ...participant(agentId),
      ...patch,
    })
  );
  vi.spyOn(EditorView.prototype, 'posAtCoords').mockImplementation(function (this: EditorView) {
    return { pos: this.state.selection.from, inside: -1 };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentDetail thread instructions', () => {
  it('explains linking and including docs in a hint beside the label', () => {
    render(<Harness agent={AGENT_A} initial={participant(AGENT_A.id)} />);
    expect(screen.getByRole('button', { name: 'About thread instructions' })).toBeInTheDocument();
  });

  it('sends nothing while typing and saves the draft on Save', async () => {
    render(<Harness agent={AGENT_A} initial={participant(AGENT_A.id)} />);
    const input = await openInstructions();

    typeAtEnd(input, 'Reply in French.');
    await pause(PAST_AUTOSAVE_MS);
    expect(api.threads.updateParticipantOverrides).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.threads.updateParticipantOverrides).toHaveBeenCalledWith(THREAD_ID, AGENT_A.id, {
        systemPromptAddendum: 'Reply in French.',
      })
    );
    expect(api.threads.updateParticipantOverrides).toHaveBeenCalledTimes(1);
  });

  it('saves trimmed text but leaves the typed text in the editor', async () => {
    render(<Harness agent={AGENT_A} initial={participant(AGENT_A.id)} />);
    const input = await openInstructions();

    typeAtEnd(input, 'Reply in French. ');
    fireEvent.keyDown(input, { key: 's', metaKey: true });

    await waitFor(() =>
      expect(api.threads.updateParticipantOverrides).toHaveBeenCalledWith(THREAD_ID, AGENT_A.id, {
        systemPromptAddendum: 'Reply in French.',
      })
    );
    await pause(50);
    // The trailing space is still there, so the next word is not glued on.
    expect(editorOf(input).getText()).toBe('Reply in French. ');
  });

  it('puts a dropped doc into the draft and sends it only on Save', async () => {
    render(<Harness agent={AGENT_A} initial={participant(AGENT_A.id)} />);
    const input = await openInstructions();

    dropDoc(input, DOC);

    await waitFor(() => expect(input.querySelectorAll('.md-chip')).toHaveLength(1));
    await pause(PAST_AUTOSAVE_MS);
    expect(api.threads.updateParticipantOverrides).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.threads.updateParticipantOverrides).toHaveBeenCalledWith(THREAD_ID, AGENT_A.id, {
        systemPromptAddendum: `[Doc A](${DOC.id})`,
      })
    );
  });

  it("keeps each agent's unsaved draft with that agent when switching agents", async () => {
    const view = render(<Harness agent={AGENT_A} initial={participant(AGENT_A.id)} />);
    typeAtEnd(await openInstructions(), 'Only for agent A.');

    view.rerender(<Harness agent={AGENT_B} initial={participant(AGENT_B.id, 'Agent B rules.')} />);
    const inputB = await openInstructions();
    await waitFor(() => expect(editorOf(inputB).getText()).toBe('Agent B rules.'));
    await pause(PAST_AUTOSAVE_MS);
    expect(api.threads.updateParticipantOverrides).not.toHaveBeenCalled();

    view.rerender(<Harness agent={AGENT_A} initial={participant(AGENT_A.id)} />);
    const inputA = await openInstructions();
    await waitFor(() => expect(editorOf(inputA).getText()).toBe('Only for agent A.'));
    expect(api.threads.updateParticipantOverrides).not.toHaveBeenCalled();
  });
});

describe("AgentDetail a subagent's instructions", () => {
  it('keeps the draft through a conflict and checks the next Save against the instructions shown', async () => {
    api.threads.listParticipants.mockResolvedValue([
      participant(HELPER.id, 'Changed by the orchestrator.'),
    ]);
    render(<Harness agent={HELPER} initial={participant(HELPER.id, 'Original instructions.')} />);
    const input = await openInstructions(/^Instructions/);
    await waitFor(() => expect(editorOf(input).getText()).toBe('Original instructions.'));

    typeAtEnd(input, ' Plus mine.');
    await pause(PAST_AUTOSAVE_MS);
    expect(api.threads.listParticipants).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Instructions changed elsewhere/)).toBeInTheDocument();
    expect(screen.getByText('Changed by the orchestrator.')).toBeInTheDocument();
    expect(api.threads.updateParticipantOverrides).not.toHaveBeenCalled();
    expect(editorOf(input).getText()).toBe('Original instructions. Plus mine.');

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.threads.updateParticipantOverrides).toHaveBeenCalledWith(THREAD_ID, HELPER.id, {
        systemPromptAddendum: 'Original instructions. Plus mine.',
        expectedSystemPromptAddendum: 'Changed by the orchestrator.',
      })
    );
    await waitFor(() => expect(screen.queryByText(/Instructions changed elsewhere/)).toBeNull());
    expect(editorOf(input).getText()).toBe('Original instructions. Plus mine.');
  });
});

describe('AgentsSection switching agents while a save is in flight', () => {
  it("leaves the next agent's instructions alone when the first agent's save finishes after the switch", async () => {
    api.agentsList.mockResolvedValue([AGENT_A, AGENT_B]);
    api.threads.listParticipants.mockResolvedValue([
      participant(AGENT_A.id),
      participant(AGENT_B.id, 'Agent B rules.'),
    ]);
    let finishSave: () => void = () => undefined;
    api.threads.updateParticipantOverrides.mockImplementationOnce(
      (_threadId: string, agentId: string, patch: Partial<ThreadParticipant>) =>
        new Promise((resolve) => {
          finishSave = () => resolve({ ...participant(agentId), ...patch });
        })
    );
    render(<AgentsSection threadId={THREAD_ID} />);
    await screen.findByRole('heading', { name: 'Test Agent A' });

    typeAtEnd(await openInstructions(), 'Only for agent A.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.threads.updateParticipantOverrides).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Agent, selected Test Agent A' }));
    await userEvent.click(screen.getByRole('option', { name: /Test Agent B/ }));
    await screen.findByRole('heading', { name: 'Test Agent B' });
    const inputB = await openInstructions();
    await waitFor(() => expect(editorOf(inputB).getText()).toBe('Agent B rules.'));

    await act(async () => finishSave());
    await pause(50);

    expect(editorOf(inputB).getText()).toBe('Agent B rules.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    typeAtEnd(inputB, ' Be brief.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.threads.updateParticipantOverrides).toHaveBeenCalledTimes(2));
    expect(api.threads.updateParticipantOverrides).toHaveBeenLastCalledWith(THREAD_ID, AGENT_B.id, {
      systemPromptAddendum: 'Agent B rules. Be brief.',
    });
  });
});
