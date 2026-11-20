import { useEffect, useRef, useState } from 'react';
import type { TableField } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { tablesApi } from '@desktop/utils/api';
import { showToast } from '@desktop/utils/toast';

/**
 * Quiet time after the last width change before it saves, so a run of
 * Alt+←/→ steps (or drags in quick succession) saves once.
 */
export const WIDTH_SAVE_DELAY_MS = 300;

/** A field's view preferences: a collapsed column, and its width (null = auto). */
interface View {
  collapsed: boolean;
  width: number | null;
}

interface ViewChange extends View {
  saving: boolean;
  afterRequest?: number;
}

interface FieldsLoadProvenance {
  latestRequest: () => number;
  completedRequest: number;
}

interface ViewSnapshot extends View {
  sequence: number;
  afterRequest?: number;
  observedRequest?: number;
}

const viewOf = (field: TableField): View => ({
  collapsed: field.collapsed,
  width: field.width ?? null,
});

const sameView = (a: View, b: View) => a.collapsed === b.collapsed && a.width === b.width;

/** The field with these preferences; an auto width leaves the key out, as the server does. */
function withView(field: TableField, view: View): TableField {
  const { width: _width, ...rest } = field;
  return view.width === null
    ? { ...rest, collapsed: view.collapsed }
    : { ...rest, collapsed: view.collapsed, width: view.width };
}

/**
 * Presentation changes stay separate from entry drafts and schema revisions.
 * A collapse toggle saves at once; a width shows at once and saves after
 * {@link WIDTH_SAVE_DELAY_MS} of quiet, the newest width winning.
 */
export function useFieldView(
  tableId: string,
  fields: TableField[],
  reload: () => void,
  load?: FieldsLoadProvenance
) {
  const [changes, setChanges] = useState<ReadonlyMap<string, ViewChange>>(new Map());
  // Widths the user has set that are not saved yet (waiting or in flight).
  const [widthDrafts, setWidthDrafts] = useState<ReadonlyMap<string, number | null>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(new Set<string>());
  const sequence = useRef(0);
  const saved = useRef(new Map<string, ViewSnapshot>());
  const drafts = useRef(new Map<string, number | null>());
  const draftSeq = useRef(new Map<string, number>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const loadRef = useRef(load);
  loadRef.current = load;
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const changesRef = useRef(changes);
  changesRef.current = changes;
  const tableIdRef = useRef(tableId);
  tableIdRef.current = tableId;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const waiting = timers.current;
    const unsaved = drafts.current;
    return () => {
      mounted.current = false;
      // A width still waiting for its quiet time saves on the way out; the
      // grid is gone, so a failure can only be told in a toast.
      for (const [id, timer] of waiting) {
        clearTimeout(timer);
        if (unsaved.has(id))
          void tablesApi
            .setFieldView(tableIdRef.current, id, { width: unsaved.get(id) ?? null })
            .catch((err: unknown) =>
              showToast(getErrorMessage(err, 'Could not save a column width'), {
                durationMs: 4000,
              })
            );
      }
      waiting.clear();
    };
  }, []);

  const setDraft = (id: string, width: number | null | undefined) => {
    if (width === undefined) drafts.current.delete(id);
    else drafts.current.set(id, width);
    setWidthDrafts(new Map(drafts.current));
  };

  useEffect(() => {
    const completedRequest = load?.completedRequest;
    for (const [id, view] of saved.current) {
      const field = fields.find((item) => item.id === id);
      if (!field) {
        saved.current.delete(id);
      } else if (
        completedRequest !== undefined &&
        completedRequest > (view.afterRequest ?? view.observedRequest ?? -1)
      ) {
        // Replace the local preference with the authoritative loaded view.
        // An earlier reorder still needs this newer snapshot, not its own save.
        saved.current.set(id, {
          ...viewOf(field),
          sequence: ++sequence.current,
          observedRequest: completedRequest,
        });
      }
    }
    for (const id of drafts.current.keys()) {
      if (fields.some((item) => item.id === id)) continue;
      clearTimeout(timers.current.get(id));
      timers.current.delete(id);
      setDraft(id, undefined);
    }
    setChanges((current) => {
      const next = new Map(current);
      for (const [id, change] of current) {
        const field = fields.find((item) => item.id === id);
        const acknowledged =
          completedRequest !== undefined && change.afterRequest !== undefined
            ? completedRequest > change.afterRequest
            : !!field && sameView(viewOf(field), change);
        if (!field || (!change.saving && acknowledged)) next.delete(id);
      }
      return next.size === current.size ? current : next;
    });
  }, [fields, changes, load?.completedRequest]);

  /** The view last saved or loaded for a field, before any unsaved width. */
  const baseView = (id: string): View | undefined => {
    const change = changesRef.current.get(id);
    if (change) return { collapsed: change.collapsed, width: change.width };
    const field = fieldsRef.current.find((item) => item.id === id);
    return field ? viewOf(field) : undefined;
  };

  async function toggle(field: TableField): Promise<boolean> {
    if (pending.current.has(field.id)) return false;
    const collapsed = !field.collapsed;
    const previous = changes.get(field.id);
    const width = baseView(field.id)?.width ?? null;
    pending.current.add(field.id);
    sequence.current += 1;
    setError(null);
    setChanges((current) => new Map(current).set(field.id, { collapsed, width, saving: true }));
    try {
      const { field: result } = await tablesApi.setFieldView(tableId, field.id, { collapsed });
      if (!mounted.current) return false;
      const afterRequest = loadRef.current?.latestRequest();
      const view = viewOf(result);
      saved.current.set(field.id, { ...view, sequence: ++sequence.current, afterRequest });
      setChanges((current) =>
        new Map(current).set(field.id, { ...view, saving: false, afterRequest })
      );
      reload();
      return true;
    } catch (err) {
      if (!mounted.current) return false;
      setChanges((current) => {
        const next = new Map(current);
        if (previous) next.set(field.id, previous);
        else next.delete(field.id);
        return next;
      });
      setError(getErrorMessage(err, `Could not change the view of ${field.name}`));
      return false;
    } finally {
      pending.current.delete(field.id);
    }
  }

  function scheduleWidthSave(id: string) {
    clearTimeout(timers.current.get(id));
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        void saveWidth(id);
      }, WIDTH_SAVE_DELAY_MS)
    );
  }

  async function saveWidth(id: string): Promise<void> {
    if (!mounted.current || !drafts.current.has(id)) return;
    // One request per field at a time: wait for a toggle or earlier width.
    if (pending.current.has(id)) {
      scheduleWidthSave(id);
      return;
    }
    const field = fieldsRef.current.find((item) => item.id === id);
    const base = baseView(id);
    if (!field || !base) {
      setDraft(id, undefined);
      return;
    }
    const width = drafts.current.get(id) ?? null;
    const draft = draftSeq.current.get(id);
    const previous = changesRef.current.get(id);
    pending.current.add(id);
    sequence.current += 1;
    setChanges((current) =>
      new Map(current).set(id, { collapsed: base.collapsed, width, saving: true })
    );
    try {
      const { field: result } = await tablesApi.setFieldView(tableIdRef.current, id, { width });
      if (!mounted.current) return;
      const afterRequest = loadRef.current?.latestRequest();
      const view = viewOf(result);
      saved.current.set(id, { ...view, sequence: ++sequence.current, afterRequest });
      setChanges((current) => new Map(current).set(id, { ...view, saving: false, afterRequest }));
      // A newer width set while this one saved keeps showing, and saves next.
      if (draftSeq.current.get(id) === draft) setDraft(id, undefined);
      reload();
    } catch (err) {
      if (!mounted.current) return;
      setChanges((current) => {
        const next = new Map(current);
        if (previous) next.set(id, previous);
        else next.delete(id);
        return next;
      });
      if (draftSeq.current.get(id) === draft) setDraft(id, undefined);
      setError(getErrorMessage(err, `Could not resize ${field.name}`));
    } finally {
      pending.current.delete(id);
    }
  }

  /**
   * Show a column at `width` (whole px, already in range; null = auto) at
   * once, and save it once changes stop for {@link WIDTH_SAVE_DELAY_MS}.
   */
  function resize(field: TableField, width: number | null): void {
    setError(null);
    draftSeq.current.set(field.id, (draftSeq.current.get(field.id) ?? 0) + 1);
    setDraft(field.id, width);
    scheduleWidthSave(field.id);
  }

  return {
    fields: fields.map((field) => {
      const change = changes.get(field.id);
      const draft = widthDrafts.get(field.id);
      if (!change && draft === undefined) return field;
      const view = change ? { collapsed: change.collapsed, width: change.width } : viewOf(field);
      return withView(field, draft === undefined ? view : { ...view, width: draft });
    }),
    pendingFieldIds: new Set([...changes].filter(([, change]) => change.saving).map(([id]) => id)),
    error,
    toggle,
    resize,
    checkpoint: () => sequence.current,
    /** A reorder started before a view save must not restore its old view. */
    reconcile: (next: TableField[], checkpoint: number) =>
      next.map((field) => {
        const view = saved.current.get(field.id);
        return view && view.sequence > checkpoint ? withView(field, view) : field;
      }),
  };
}
