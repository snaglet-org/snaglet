import { useState } from 'react';
import type { Editor } from '@tiptap/core';
import { EditorView } from '@tiptap/pm/view';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaletteAugmentedResponse } from '@desktop/utils/api/palette-search';
import { NODE_CHIP_MIME, setActiveDragChip, type NodeChipData } from '@desktop/utils/nodeChip';
import { TEST_THREAD_ID, stubEditorLayout } from './testFixtures';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const search = vi.hoisted(() => vi.fn());
vi.mock('@desktop/hooks/useTieredSearch', () => ({
  useTieredSearch: search,
  stableMergeById: <T,>(instant: readonly T[], enriched: readonly T[]) => [...instant, ...enriched],
}));

const people = vi.hoisted(() => ({ agents: vi.fn() }));
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: () => people.agents() } };
});

import { FetchError } from '@desktop/utils/api';
import {
  AutomationChipPicker,
  threadIdFromText,
  type AutomationChipPickerProps,
  type ChipPick,
} from './AutomationChipPicker';

const THREAD: ChipPick = { id: TEST_THREAD_ID, title: 'Test thread' };

/** Palette search: the thread hit for "Test", nothing else. */
function threadSearch({ query, enabled }: { query: string; enabled: boolean }) {
  const hit = enabled && 'test thread'.includes(query.trim().toLowerCase()) && query.trim();
  const response: PaletteAugmentedResponse | null = hit
    ? {
        byKind: {},
        channelsUsed: ['fts'],
        semanticStatus: 'ready',
        coverage: {},
        items: [
          {
            type: 'workspace',
            nodeId: TEST_THREAD_ID,
            nodeType: 'thread',
            title: 'Test thread',
            subtitle: null,
            icon: null,
            score: 1,
            archived: false,
          },
        ],
        filesystem: [],
        files: [],
        meta: { query, kinds: ['thread'], workspaceCount: 1, filesystemCount: 0 },
      }
    : null;
  return { instant: response, enriched: null, instantLoading: false, enrichmentLoading: false };
}

beforeAll(stubEditorLayout);

beforeEach(() => {
  search.mockReset();
  search.mockImplementation(threadSearch);
  people.agents.mockReset();
  people.agents.mockResolvedValue([
    { id: 'test-agent-a', name: 'Test Agent A', role: null },
    { id: 'test-agent-b', name: 'Test Agent B', role: null },
  ]);
  vi.spyOn(EditorView.prototype, 'posAtCoords').mockImplementation(function (this: EditorView) {
    return { pos: this.state.selection.from, inside: -1 };
  });
});

afterEach(async () => {
  await act(async () => cleanup());
  setActiveDragChip(null);
  vi.restoreAllMocks();
});

function Harness(
  props: Omit<AutomationChipPickerProps, 'value' | 'onChange'> & {
    onPick: (pick: ChipPick | null) => void;
  }
) {
  const { onPick, ...rest } = props;
  const [value, setValue] = useState<ChipPick | null>(null);
  return (
    <AutomationChipPicker
      {...rest}
      value={value}
      onChange={(next) => {
        setValue(next);
        onPick(next);
      }}
    />
  );
}

function renderAgentPicker() {
  const onPick = vi.fn();
  render(<Harness kind="agent" label="Agent" placeholder="Find an agent" onPick={onPick} />);
  return { onPick, input: screen.getByRole('textbox', { name: 'Agent' }) };
}

function renderThreadPicker(resolve = vi.fn(async (id: string) => ({ ...THREAD, id }))) {
  const onPick = vi.fn();
  render(
    <Harness
      kind="thread"
      label="Thread"
      placeholder="Find a thread"
      resolve={resolve}
      idFromText={threadIdFromText}
      onPick={onPick}
    />
  );
  return { onPick, resolve, input: screen.getByRole('textbox', { name: 'Thread' }) };
}

function paste(element: HTMLElement, text: string) {
  fireEvent.paste(element, {
    clipboardData: {
      types: ['text/plain'],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    },
  });
}

function drop(element: HTMLElement, chip: NodeChipData) {
  const dataTransfer = {
    types: [NODE_CHIP_MIME],
    getData: (type: string) => (type === NODE_CHIP_MIME ? JSON.stringify(chip) : ''),
    dropEffect: 'copy',
    files: [],
  };
  fireEvent.dragOver(element, { dataTransfer, clientX: 0, clientY: 0 });
  fireEvent.drop(element, { dataTransfer, clientX: 0, clientY: 0 });
}

/** TipTap hangs its editor on the contenteditable. */
const editorOf = (input: HTMLElement) => (input as HTMLElement & { editor?: Editor }).editor;

const chipIn = (input: HTMLElement, kind: string) =>
  input.querySelector(`[data-node-kind="${kind}"]`);

describe('threadIdFromText', () => {
  it('reads a thread id, its scheme form and a wiki link, and nothing else', () => {
    expect(threadIdFromText(TEST_THREAD_ID)).toBe(TEST_THREAD_ID);
    expect(threadIdFromText(` thread:${TEST_THREAD_ID} `)).toBe(TEST_THREAD_ID);
    expect(threadIdFromText(`[Test thread](${TEST_THREAD_ID})`)).toBe(TEST_THREAD_ID);
    expect(threadIdFromText(`[Te\\]st](thread:${TEST_THREAD_ID})`)).toBe(TEST_THREAD_ID);
    expect(threadIdFromText('[Doc](doc-1111111111111-aaaaaaaaa)')).toBeNull();
    expect(threadIdFromText('thread-nope')).toBeNull();
    expect(threadIdFromText('Test thread')).toBeNull();
  });
});

describe('AutomationChipPicker: agent', () => {
  it('searches agents as you type, picks one as a chip, and Backspace removes it', async () => {
    const user = userEvent.setup();
    const { onPick, input } = renderAgentPicker();
    await user.click(input);
    await user.keyboard('Test');

    const option = await screen.findByRole('option', { name: /Test Agent A/ });
    expect(screen.getByRole('option', { name: /Test Agent B/ })).toBeInTheDocument();
    // Agents only: the workspace search is never asked.
    expect(search).not.toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    fireEvent.mouseDown(option);

    await waitFor(() =>
      expect(onPick).toHaveBeenLastCalledWith({ id: 'test-agent-a', title: 'Test Agent A' })
    );
    await waitFor(() => expect(chipIn(input, 'agent')).toHaveTextContent('Test Agent A'));
    expect(input).not.toHaveTextContent('Test Agent ATest');

    // A browser's Backspace deletes the atom chip natively (jsdom cannot), so
    // select the chip the way ArrowLeft would, and Backspace deletes the selection.
    act(() => {
      editorOf(input)?.commands.setNodeSelection(1);
    });
    await user.keyboard('{Backspace}');
    await waitFor(() => expect(onPick).toHaveBeenLastCalledWith(null));
    expect(chipIn(input, 'agent')).toBeNull();
  });

  it('picking another agent replaces the first: one agent only', async () => {
    const user = userEvent.setup();
    const { onPick, input } = renderAgentPicker();
    await user.click(input);
    await user.keyboard('@');
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Test Agent A/ }));
    await waitFor(() => expect(chipIn(input, 'agent')).toBeInTheDocument());

    await user.keyboard('Agent B');
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Test Agent B/ }));
    await waitFor(() =>
      expect(onPick).toHaveBeenLastCalledWith({ id: 'test-agent-b', title: 'Test Agent B' })
    );
    await waitFor(() => expect(input.querySelectorAll('[data-node-kind="agent"]')).toHaveLength(1));
    expect(chipIn(input, 'agent')).toHaveTextContent('Test Agent B');
  });
});

describe('AutomationChipPicker: thread', () => {
  it('quick-searches threads only and picks one', async () => {
    const user = userEvent.setup();
    const { onPick, resolve, input } = renderThreadPicker();
    await user.click(input);
    await user.keyboard('Test');

    fireEvent.mouseDown(await screen.findByRole('option', { name: /Test thread/ }));
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, kinds: ['thread'] })
    );
    // No agents in a thread search.
    expect(screen.queryByRole('option', { name: /Test Agent/ })).toBeNull();
    await waitFor(() => expect(onPick).toHaveBeenLastCalledWith(THREAD));
    expect(resolve).toHaveBeenCalledWith(TEST_THREAD_ID);
    expect(chipIn(input, 'thread')).toHaveTextContent('Test thread');
  });

  it('resolves a pasted thread id to its chip', async () => {
    const user = userEvent.setup();
    const { onPick, resolve, input } = renderThreadPicker();
    await user.click(input);
    paste(input, TEST_THREAD_ID);

    await waitFor(() => expect(onPick).toHaveBeenLastCalledWith(THREAD));
    expect(resolve).toHaveBeenCalledWith(TEST_THREAD_ID);
    await waitFor(() => expect(chipIn(input, 'thread')).toHaveTextContent('Test thread'));
  });

  it('resolves a pasted wiki link to its thread', async () => {
    const user = userEvent.setup();
    const { onPick, resolve, input } = renderThreadPicker();
    await user.click(input);
    paste(input, `[Old title](${TEST_THREAD_ID})`);

    await waitFor(() => expect(onPick).toHaveBeenLastCalledWith(THREAD));
    expect(resolve).toHaveBeenCalledWith(TEST_THREAD_ID);
    await waitFor(() => expect(chipIn(input, 'thread')).toHaveTextContent('Test thread'));
  });

  it('resolves a typed id on Enter, even while the search is open', async () => {
    const user = userEvent.setup();
    const { onPick, input } = renderThreadPicker();
    await user.click(input);
    await user.keyboard(TEST_THREAD_ID);
    await user.keyboard('{Enter}');

    await waitFor(() => expect(onPick).toHaveBeenLastCalledWith(THREAD));
    await waitFor(() => expect(chipIn(input, 'thread')).toBeInTheDocument());
    // Enter never split the one-line field.
    expect(input.querySelectorAll('p')).toHaveLength(1);
  });

  it('says an unknown thread id was not found and keeps no chip', async () => {
    const user = userEvent.setup();
    const resolve = vi.fn(async (id: string): Promise<ChipPick> => {
      throw new Error(`Thread ${id} not found.`);
    });
    const { onPick, input } = renderThreadPicker(resolve);
    await user.click(input);
    paste(input, 'thread-2222222222222-bbbbbbbbb');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Thread thread-2222222222222-bbbbbbbbb not found.'
    );
    await waitFor(() => expect(chipIn(input, 'thread')).toBeNull());
    expect(onPick).not.toHaveBeenCalledWith(expect.objectContaining({ id: expect.any(String) }));
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('takes a thread dropped from the sidebar', async () => {
    const { onPick, resolve, input } = renderThreadPicker();
    drop(input, { id: TEST_THREAD_ID, kind: 'thread', title: 'Test thread' });

    await waitFor(() => expect(onPick).toHaveBeenLastCalledWith(THREAD));
    expect(resolve).toHaveBeenCalledWith(TEST_THREAD_ID);
    await waitFor(() => expect(chipIn(input, 'thread')).toHaveTextContent('Test thread'));
  });

  it('refuses a drop that is not a thread', async () => {
    const { onPick, resolve, input } = renderThreadPicker();
    drop(input, { id: 'doc-1111111111111-aaaaaaaaa', kind: 'doc', title: 'Test doc' });

    expect(await screen.findByRole('alert')).toHaveTextContent('Drop a thread here');
    expect(chipIn(input, 'doc')).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('turns away a pasted link to something else', async () => {
    const user = userEvent.setup();
    const { onPick, input } = renderThreadPicker();
    await user.click(input);
    paste(input, '[Test doc](doc-1111111111111-aaaaaaaaa)');

    expect(await screen.findByRole('alert')).toHaveTextContent("That isn't a thread.");
    await waitFor(() => expect(chipIn(input, 'doc')).toBeNull());
    expect(onPick).not.toHaveBeenCalled();
  });

  it('shows a lookup failure that is not "not found" as given', async () => {
    const user = userEvent.setup();
    const resolve = vi.fn(async (): Promise<ChipPick> => {
      throw new FetchError('Server unavailable', 503);
    });
    const { input } = renderThreadPicker(resolve);
    await user.click(input);
    paste(input, TEST_THREAD_ID);
    expect(await screen.findByRole('alert')).toHaveTextContent('Server unavailable');
  });
});
