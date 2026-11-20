import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TableHistoryResponse,
  TableHistoryStep,
  TableHistoryStepRequest,
  TableHistoryStepResponse,
} from '@snaglet/shared/types';
import { PaneFindProvider } from '@desktop/features/pane-find/PaneFindContext';
import { __resetTableHistoryForTests } from '@desktop/features/database/tableHistory';
import type { TableHistoryPrepared } from '@desktop/features/database/tableHistory';
import { TableUndoButtons } from './TableUndoButtons';
import { TableUndoProvider, useTableUndo, useTableUndoController } from './tableUndo';

const api = vi.hoisted(() => ({
  history: vi.fn<(limit?: number) => Promise<TableHistoryResponse>>(),
  stepHistory:
    vi.fn<
      (
        direction: 'undo' | 'redo',
        input?: TableHistoryStepRequest
      ) => Promise<TableHistoryStepResponse>
    >(),
}));
vi.mock('@desktop/utils/api', async () => {
  const core =
    await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
  return { tablesApi: api, FetchError: core.FetchError };
});
vi.mock('@desktop/utils/toast', () => ({ showToast: vi.fn() }));

const TABLE = 'table-1111111111111-aaaaaaaaa';
const actor = { kind: 'user' as const, id: 'user-test', name: 'Test User' };
function step(n: number, label: string, kind: TableHistoryStep['kind'] = 'field.update') {
  return {
    id: `step-${n}`,
    actor,
    kind,
    label,
    tableIds: [TABLE],
    state: 'done' as const,
    seq: n,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}
const rename = step(2, 'Change field notes in test_items');
const added = step(1, 'Add entry to test_items', 'entry.create');

function Harness({ children, enabled = true }: { children?: ReactNode; enabled?: boolean }) {
  const control = useTableUndoController(TABLE, enabled);
  return (
    <TableUndoProvider value={control}>
      <div role="toolbar" aria-label="Table actions">
        <TableUndoButtons />
      </div>
      {children}
    </TableUndoProvider>
  );
}
function setup(
  children?: ReactNode,
  { active = true, enabled = true }: { active?: boolean; enabled?: boolean } = {}
) {
  return render(
    <PaneFindProvider isActive={active}>
      <Harness enabled={enabled}>{children}</Harness>
    </PaneFindProvider>
  );
}
async function loaded() {
  await waitFor(() => expect(screen.getByRole('button', { name: /^Undo change/ })).toBeEnabled());
}
function pressUndo(target: Element | Window = document.body, extra: KeyboardEventInit = {}) {
  return fireEvent.keyDown(target, { key: 'z', metaKey: true, ...extra });
}

beforeEach(() => {
  vi.resetAllMocks();
  __resetTableHistoryForTests();
  api.history.mockResolvedValue({ actor, steps: [rename], undo: rename, redo: added, depth: 100 });
  api.stepHistory.mockImplementation((direction) =>
    Promise.resolve({
      step: direction === 'undo' ? rename : added,
      undo: direction === 'undo' ? null : rename,
      redo: direction === 'undo' ? rename : null,
    })
  );
});
afterEach(() => __resetTableHistoryForTests());

describe('table Undo and Redo buttons', () => {
  it('name the next steps and run the one they name', async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    const undo = screen.getByRole('button', { name: 'Undo change field notes in test_items' });
    expect(undo).toHaveAttribute('title', 'Undo change field notes in test_items (Cmd/Ctrl+Z)');
    expect(screen.getByRole('button', { name: 'Redo add entry to test_items' })).toBeEnabled();
    await user.click(undo);
    await waitFor(() => expect(api.stepHistory).toHaveBeenCalledWith('undo', { stepId: 'step-2' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveAttribute(
      'title',
      'Nothing to undo'
    );
  });

  it('are disabled with nothing to undo or redo', async () => {
    api.history.mockResolvedValue({ actor, steps: [], undo: null, redo: null, depth: 100 });
    setup();
    await waitFor(() => expect(api.history).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
  });
});

describe('table undo shortcuts', () => {
  it('undo with Cmd/Ctrl+Z and redo with Cmd/Ctrl+Shift+Z in the active pane', async () => {
    setup();
    await loaded();
    expect(pressUndo()).toBe(false);
    await waitFor(() => expect(api.stepHistory).toHaveBeenCalledWith('undo', { stepId: 'step-2' }));
    api.history.mockResolvedValue({ actor, steps: [], undo: null, redo: rename, depth: 100 });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Redo/ })).toBeEnabled());
    expect(fireEvent.keyDown(document.body, { key: 'Z', ctrlKey: true, shiftKey: true })).toBe(
      false
    );
    await waitFor(() =>
      expect(api.stepHistory).toHaveBeenLastCalledWith('redo', expect.anything())
    );
  });

  it('leave native text undo alone in inputs, textareas and rich editors', async () => {
    setup(
      <>
        <input aria-label="Cell text" />
        <textarea aria-label="Notes" />
        <div contentEditable="true" suppressContentEditableWarning aria-label="Rich">
          <span>chip text</span>
        </div>
      </>
    );
    await loaded();
    const input = screen.getByRole('textbox', { name: 'Cell text' });
    input.focus();
    expect(pressUndo(input)).toBe(true);
    const notes = screen.getByRole('textbox', { name: 'Notes' });
    notes.focus();
    expect(pressUndo(notes, { shiftKey: true })).toBe(true);
    expect(pressUndo(screen.getByText('chip text'))).toBe(true);
    notes.blur();
    expect(api.stepHistory).not.toHaveBeenCalled();
  });

  it('still work with a checkbox or button focused', async () => {
    setup(<input type="checkbox" aria-label="Select entry" />);
    await loaded();
    const checkbox = screen.getByRole('checkbox', { name: 'Select entry' });
    checkbox.focus();
    expect(pressUndo(checkbox)).toBe(false);
    await waitFor(() => expect(api.stepHistory).toHaveBeenCalledOnce());
  });

  it('stand down in an inactive pane, outside a custom table, in the sidebar or a dialog', async () => {
    const inactive = setup(undefined, { active: false });
    await loaded();
    expect(pressUndo()).toBe(true);
    inactive.unmount();

    __resetTableHistoryForTests();
    const builtin = setup(undefined, { enabled: false });
    expect(pressUndo()).toBe(true);
    builtin.unmount();

    __resetTableHistoryForTests();
    const view = setup(
      <aside id="dashboard-sidebar">
        <button type="button">Tree row</button>
      </aside>
    );
    await loaded();
    screen.getByRole('button', { name: 'Tree row' }).focus();
    expect(pressUndo()).toBe(true);
    screen.getByRole('button', { name: 'Tree row' }).blur();
    view.rerender(
      <PaneFindProvider isActive>
        <Harness>
          <div role="dialog" aria-label="Field settings" />
        </Harness>
      </PaneFindProvider>
    );
    expect(pressUndo()).toBe(true);
    expect(api.stepHistory).not.toHaveBeenCalled();
  });

  it('fall through when there is nothing to undo, and stop keys they handle', async () => {
    const bubbled = vi.fn();
    window.addEventListener('keydown', bubbled);
    api.history.mockResolvedValue({ actor, steps: [rename], undo: rename, redo: null, depth: 100 });
    setup();
    await loaded();
    expect(pressUndo(document.body, { shiftKey: true })).toBe(true);
    expect(bubbled).toHaveBeenCalledTimes(1);
    expect(pressUndo()).toBe(false);
    expect(bubbled).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', bubbled);
    await waitFor(() => expect(api.stepHistory).toHaveBeenCalledOnce());
  });

  it('let the grid save its open row before the step runs', async () => {
    const order: string[] = [];
    function Grid() {
      const prepareRef = useTableUndo()?.prepareRef;
      useEffect(() => {
        if (!prepareRef) return;
        prepareRef.current = async (): Promise<TableHistoryPrepared> => {
          order.push('prepare');
          return 'ready';
        };
      }, [prepareRef]);
      return null;
    }
    api.stepHistory.mockImplementation(() => {
      order.push('step');
      return Promise.resolve({ step: rename, undo: null, redo: rename });
    });
    setup(<Grid />);
    await loaded();
    pressUndo();
    await waitFor(() => expect(order).toEqual(['prepare', 'step']));
  });
});
