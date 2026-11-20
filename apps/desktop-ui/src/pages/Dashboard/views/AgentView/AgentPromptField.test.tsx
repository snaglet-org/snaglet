/**
 * The identity / system prompt field when someone else changes the same text
 * while the user is editing it. The user's draft stays on screen and is not
 * saved over the other change until they pick: Keep mine saves what they see
 * (the draft, or the text they had focused), Reload drops the draft and shows
 * the saved text in a fresh editor that the old one can no longer write past.
 * With no change waiting, saves go straight through as before.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentPromptField } from './AgentPromptField';
import type { EditingProbe, LiveConflict, SaveGate } from './agentLiveFields';

type EditorSave = (next: string) => unknown;
interface CapturedEditor {
  savedValue: string;
  onSave: EditorSave;
  onSaveStateChange?: (state: string, error: string | null) => void;
}

const editor = vi.hoisted(() => ({
  renders: [] as CapturedEditor[],
  mounts: 0,
  flush: vi.fn(async (): Promise<string> => ''),
}));

vi.mock('@desktop/features/rich-markdown/workspace-editor', () => ({
  WorkspaceEditor: forwardRef<{ focus: () => void; flush: () => Promise<string> }, CapturedEditor>(
    function MockEditor(props, ref) {
      editor.renders.push(props);
      useImperativeHandle(ref, () => ({ focus: () => undefined, flush: editor.flush }), []);
      useEffect(() => {
        editor.mounts += 1;
      }, []);
      return <textarea data-testid="editor-input" readOnly value={props.savedValue} />;
    }
  ),
  EditorSaveHint: ({ state }: { state: string }) => <span data-testid="save-hint">{state}</span>,
  useEditorSaveStatus: () => {
    const [status, setStatus] = useState({ state: 'pristine', error: null as string | null });
    return {
      status,
      onSaveStateChange: (state: string, error: string | null) => setStatus({ state, error }),
    };
  },
}));

const latest = (): CapturedEditor => editor.renders[editor.renders.length - 1]!;
const remote: LiveConflict = { remote: 'Remote prompt', by: 'Venus' };

interface FieldProps {
  value?: string;
  conflict?: LiveConflict | null;
  editingProbe?: EditingProbe;
  saveGate?: SaveGate;
  waiting?: boolean;
}

function renderField(props: FieldProps) {
  const onSave = vi.fn(async (_next: string) => undefined);
  const onResolveConflict = vi.fn();
  const onKeepDraft = vi.fn();
  const element = (p: FieldProps) => (
    <AgentPromptField
      kind="agent-system-prompt"
      testId="prompt-section"
      placeholder="Write it"
      value={p.value ?? 'Old prompt'}
      onSave={onSave}
      conflict={p.conflict ?? null}
      onResolveConflict={onResolveConflict}
      editingProbe={p.editingProbe}
      saveGate={p.saveGate}
      waiting={p.waiting}
      onKeepDraft={onKeepDraft}
    />
  );
  const view = render(element(props));
  const rerender = (next: FieldProps) => view.rerender(element(next));
  return { view, rerender, onSave, onResolveConflict, onKeepDraft };
}

beforeEach(() => {
  editor.renders.length = 0;
  editor.mounts = 0;
  editor.flush.mockReset();
});

describe('AgentPromptField with no remote change waiting', () => {
  it('hands each save straight to the pane', async () => {
    const { onSave } = renderField({});
    await act(async () => {
      await latest().onSave('Typed');
    });
    expect(onSave).toHaveBeenCalledWith('Typed');
  });

  it('tells the pane the user is editing while focused or holding an unsaved draft', () => {
    const probe: EditingProbe = { current: null };
    renderField({ editingProbe: probe });
    expect(probe.current?.()).toBe(false);

    act(() => latest().onSaveStateChange?.('dirty', null));
    expect(probe.current?.()).toBe(true);
    act(() => latest().onSaveStateChange?.('pristine', null));
    expect(probe.current?.()).toBe(false);

    act(() => screen.getByTestId('editor-input').focus());
    expect(probe.current?.()).toBe(true);
  });
});

describe('AgentPromptField while a remote change waits', () => {
  it('says who changed it, and holds the draft’s save instead of writing over it', async () => {
    const { onSave } = renderField({ conflict: remote });
    expect(screen.getByRole('status')).toHaveTextContent('Updated by Venus just now.');
    expect(screen.queryByTestId('save-hint')).toBeNull();

    let settled = false;
    void Promise.resolve(latest().onSave('My draft')).then(() => (settled = true));
    await act(async () => undefined);

    expect(onSave).not.toHaveBeenCalled();
    expect(settled).toBe(false);
  });

  it('Keep mine saves the held draft over the other change', async () => {
    editor.flush.mockResolvedValue('My draft');
    const { onSave, onResolveConflict } = renderField({ conflict: remote });
    const heldSave = Promise.resolve(latest().onSave('My draft'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    });
    await act(async () => {
      await heldSave;
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('My draft');
    // The pane learns which change was answered, so a newer one stays open.
    expect(onResolveConflict).toHaveBeenCalledWith({ keptOver: remote, kept: 'My draft' });
  });

  it('Keep mine on a focused field with no draft saves the text it shows', async () => {
    editor.flush.mockResolvedValue('Old prompt');
    const { onSave, onResolveConflict } = renderField({ conflict: remote });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    });

    expect(onSave).toHaveBeenCalledWith('Old prompt');
    expect(onResolveConflict).toHaveBeenCalledTimes(1);
  });

  it('Reload drops the draft without writing and starts a fresh editor on the saved text', async () => {
    const { rerender, onSave, onResolveConflict } = renderField({ conflict: remote });
    const oldEditorSave = latest().onSave;
    const heldSave = Promise.resolve(oldEditorSave('My draft'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reload to see it' }));
    });
    // The pane clears the conflict and feeds the saved value.
    rerender({ value: 'Remote prompt', conflict: null });

    // The held save ends on the saved text, never written.
    await expect(heldSave).resolves.toBe('Remote prompt');
    expect(onResolveConflict).toHaveBeenCalledTimes(1);
    expect(editor.mounts).toBe(2);
    expect(latest().savedValue).toBe('Remote prompt');
    // The dropped editor's last flush (it runs on unmount) cannot write either.
    await act(async () => {
      await oldEditorSave('My draft, again');
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('closing before a choice (a tab switch) keeps the draft for later and writes nothing', async () => {
    const { view, onSave, onKeepDraft } = renderField({ conflict: remote });
    const editorSave = latest().onSave;
    const heldSave = Promise.resolve(editorSave('My draft'));

    view.unmount();
    await heldSave;
    expect(onKeepDraft).toHaveBeenLastCalledWith('My draft');
    // Text typed after that save arrives with the closing editor's last save.
    await Promise.resolve(editorSave('My draft, more'));
    expect(onKeepDraft).toHaveBeenLastCalledWith('My draft, more');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('a conflict that goes away on its own (changed back) lets the held draft save', async () => {
    const { rerender, onSave } = renderField({ conflict: remote });
    const heldSave = Promise.resolve(latest().onSave('My draft'));
    await act(async () => undefined);
    expect(onSave).not.toHaveBeenCalled();

    rerender({ conflict: null });
    await act(async () => {
      await heldSave;
    });

    expect(onSave).toHaveBeenCalledWith('My draft');
  });
});

describe('AgentPromptField while a change is on its way', () => {
  it('holds a save until the change lands, then writes it when there is nothing to choose', async () => {
    const gate: SaveGate = { current: true };
    const { rerender, onSave } = renderField({ saveGate: gate, waiting: true });
    const heldSave = Promise.resolve(latest().onSave('My draft'));
    await act(async () => undefined);
    expect(onSave).not.toHaveBeenCalled();

    gate.current = false;
    rerender({ saveGate: gate, waiting: false });
    await act(async () => {
      await heldSave;
    });

    expect(onSave).toHaveBeenCalledWith('My draft');
  });

  it('keeps holding when the change lands as a conflict', async () => {
    const gate: SaveGate = { current: true };
    const { rerender, onSave } = renderField({ saveGate: gate, waiting: true });
    void Promise.resolve(latest().onSave('My draft'));

    // The gate stays shut: the conflict is open now.
    rerender({ saveGate: gate, waiting: false, conflict: remote });
    await act(async () => undefined);

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Updated by Venus just now.');
  });
});
