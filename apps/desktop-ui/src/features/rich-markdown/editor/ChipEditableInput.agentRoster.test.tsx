import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WsMessage } from '@snaglet/shared/types';
import type { WorkspaceEvent } from '@snaglet/shared/types/workspace-events';
import { useWorkspaceEventBridge } from '@desktop/ws/useWorkspaceEventBridge';
import { ChipEditableInput } from './ChipEditableInput';
import { ensureAgents, refreshAgents } from './agentMentionCache';

const api = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: api.list } };
});

const ws = vi.hoisted(() => ({ listeners: new Set<(message: WsMessage) => void>() }));

vi.mock('@desktop/ws/useWs', () => ({
  useWs: () => ({
    connectionState: 'closed',
    subscribe: () => undefined,
    unsubscribe: () => undefined,
    addMessageListener: (listener: (message: WsMessage) => void) => {
      ws.listeners.add(listener);
      return () => ws.listeners.delete(listener);
    },
  }),
}));

beforeAll(() => {
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
  if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () => new DOMRect();
});

afterEach(() => {
  cleanup();
  ws.listeners.clear();
});

const agentA = { id: 'test-agent-a', name: 'Test Agent A' };

function agentEvent(changed: string[]): WorkspaceEvent {
  return {
    type: 'agent.updated',
    agentId: agentA.id,
    changed,
    ts: '2026-11-03T00:00:00.000Z',
    actor: { actorId: 'user-1', actorKind: 'user' },
  };
}

function dispatchWorkspace(event: WorkspaceEvent): void {
  const message = { type: 'event', channel: 'workspace', payload: event } as WsMessage;
  act(() => {
    for (const listener of [...ws.listeners]) listener(message);
  });
}

function Bridge() {
  useWorkspaceEventBridge();
  return null;
}

describe('ChipEditableInput agent roster changes', () => {
  it('turns a link to an agent the roster lacked into an agent chip once an agent event arrives', async () => {
    // The page hydrated its roster before the agent existed (or while it was archived).
    api.list.mockResolvedValue([]);
    await ensureAgents();

    const view = render(
      <>
        <Bridge />
        <ChipEditableInput
          value="Ask [Test Agent A](test-agent-a) to review."
          onChange={vi.fn()}
          ariaLabel="Doc body"
          richBlocks
          multiline
          keepSelectionOnExternalChange
        />
      </>
    );
    await act(async () => Promise.resolve());
    const textbox = screen.getByRole('textbox', { name: 'Doc body' });
    expect(textbox).toHaveTextContent('Test Agent A');
    expect(view.container.querySelector('[data-node-kind="agent"]')).toBeNull();

    // The agent is restored from the Archive (or created) somewhere else.
    api.list.mockResolvedValue([agentA]);
    dispatchWorkspace(agentEvent(['archived']));

    await waitFor(() =>
      expect(view.container.querySelector('[data-node-kind="agent"]')).not.toBeNull()
    );
    const chip = view.container.querySelector('[data-node-kind="agent"]');
    expect(chip).toHaveClass('md-chip-agent');
    expect(chip).toHaveTextContent('Test Agent A');
  });

  it('keeps the caret on the same text, the blank lines and the host value as they were', async () => {
    api.list.mockResolvedValue([]);
    await refreshAgents();
    const onChange = vi.fn();
    let editor: Editor | null = null;
    render(
      <ChipEditableInput
        value="Ask [Test Agent A](test-agent-a) to review."
        onChange={onChange}
        ariaLabel="Notes"
        richBlocks
        multiline
        onEditorReady={(ready) => {
          editor = ready;
        }}
      />
    );
    await act(async () => Promise.resolve());
    const ready = editor as Editor | null;
    if (!ready) throw new Error('editor not ready');
    // Blank paragraphs the rich markdown serializer would drop, then a caret
    // after "to" in the text that follows the link.
    act(() => {
      ready.view.focus();
      ready.commands.setTextSelection(ready.state.doc.content.size - 1);
      ready.commands.enter();
      ready.commands.enter();
      ready.commands.setTextSelection(20);
    });
    const caretText = () =>
      ready.state.doc.textBetween(ready.state.selection.from - 3, ready.state.selection.from);
    expect(caretText()).toBe(' to');
    const blocks = ready.state.doc.childCount;
    expect(blocks).toBe(3);
    const edits = onChange.mock.calls.length;

    api.list.mockResolvedValue([agentA]);
    await act(async () => {
      await refreshAgents();
    });

    expect(
      screen.getByRole('textbox', { name: 'Notes' }).querySelector('.md-chip-agent')
    ).not.toBeNull();
    expect(caretText()).toBe(' to');
    expect(ready.state.doc.childCount).toBe(blocks);
    // Not a user edit: nothing to autosave, and no undo step of its own.
    expect(onChange).toHaveBeenCalledTimes(edits);
    act(() => {
      ready.commands.undo();
    });
    expect(ready.state.doc.childCount).toBe(1);
    expect(
      screen.getByRole('textbox', { name: 'Notes' }).querySelector('.md-chip-agent')
    ).not.toBeNull();
  });

  it('leaves a document without links to a newly known agent untouched', async () => {
    api.list.mockResolvedValue([]);
    await refreshAgents();
    let editor: Editor | null = null;
    render(
      <ChipEditableInput
        value="See [Venus](venus) and [a site](https://example.com)."
        onChange={vi.fn()}
        ariaLabel="Notes"
        richBlocks
        multiline
        onEditorReady={(ready) => {
          editor = ready;
        }}
      />
    );
    await act(async () => Promise.resolve());
    const ready = editor as Editor | null;
    if (!ready) throw new Error('editor not ready');
    const before = ready.state.doc;

    api.list.mockResolvedValue([agentA]);
    await act(async () => {
      await refreshAgents();
    });

    expect(ready.state.doc).toBe(before);
  });

  it('keeps the marks the whole link carried, so a bold link becomes a bold chip', async () => {
    api.list.mockResolvedValue([]);
    await refreshAgents();
    let editor: Editor | null = null;
    render(
      <ChipEditableInput
        value="Ask **[Test Agent A](test-agent-a)** and [*Test* Agent A](test-agent-a)."
        onChange={vi.fn()}
        ariaLabel="Notes"
        richBlocks
        multiline
        onEditorReady={(ready) => {
          editor = ready;
        }}
      />
    );
    await act(async () => Promise.resolve());
    const ready = editor as Editor | null;
    if (!ready) throw new Error('editor not ready');

    api.list.mockResolvedValue([agentA]);
    await act(async () => {
      await refreshAgents();
    });

    const chips: string[][] = [];
    ready.state.doc.descendants((node) => {
      if (node.type.name === 'chip') chips.push(node.marks.map((mark) => mark.type.name));
    });
    // Only the marks all of a label carries move onto its chip, as a reload would.
    expect(chips).toEqual([['bold'], []]);
  });

  it('chips a link whose agent arrived between parsing a value and applying it', async () => {
    api.list.mockResolvedValue([]);
    await refreshAgents();

    // The roster load settles after the value is parsed but before it is applied.
    api.list.mockResolvedValue([agentA]);
    const loading = refreshAgents();
    const view = render(
      <ChipEditableInput
        value="Ask [Test Agent A](test-agent-a) to review."
        onChange={vi.fn()}
        ariaLabel="Notes"
        richBlocks
        multiline
      />
    );
    await act(async () => {
      await loading;
      await Promise.resolve();
    });

    expect(view.container.querySelector('[data-node-kind="agent"]')).not.toBeNull();
  });
});
