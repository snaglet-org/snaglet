import { useEffect, useRef, useState } from 'react';
import type {
  TableEntry,
  TableEntryValue,
  TableEntryValues,
  TableField,
} from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { emitTableEvent } from '@desktop/features/database';
import { FetchError, tablesApi } from '@desktop/utils/api';
import { createSelectOption } from './createSelectOption';
import { noteRepeatAdvance } from './repeatAdvanceToast';
import { entryValueList } from './entryValueList';
import { newEntryValues } from './entryRows';
import { entryValueProblem } from './dateRange';

interface EntryDraft {
  id: string;
  original?: TableEntry;
  values: TableEntryValues;
  fields: TableField[];
  schemaVersion: string;
  /** The cell being edited; undefined while a closed row finishes saving. */
  focusFieldId?: string;
  editorGeneration: number;
  /** New rows only: insert before this entry instead of appending. */
  beforeEntryId?: string;
}

interface BeginOptions {
  /** Direct controls write through the draft without opening a cell editor. */
  editCell?: boolean;
  beforeEntryId?: string;
  /** Existing unsaved row; distinct from opening a fresh ghost row. */
  draftId?: string;
  /** Applied to the focused field before scheduling any write. */
  updateValue?: (previous: TableEntryValue) => TableEntryValue;
}

export type EntrySaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

const SAVE_DELAY_MS = 450;
const SAVED_FADE_MS = 1400;

function sameValue(left: TableEntryValue, right: TableEntryValue, field?: TableField): boolean {
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((value, index) =>
        field?.type === 'relation' && !field.referenceKind
          ? value.toLowerCase() === right[index].toLowerCase()
          : value === right[index]
      )
    );
  return left === right;
}

function changedValues(draft: EntryDraft): TableEntryValues {
  const write: TableEntryValues = {};
  for (const field of draft.fields) {
    if (field.managed) continue;
    const value = draft.values[field.id] ?? null;
    if (!draft.original || !sameValue(value, draft.original.values[field.id] ?? null, field)) {
      write[field.id] = value;
    }
  }
  return write;
}

function validationErrors(draft: EntryDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of draft.fields) {
    if (field.managed) continue;
    const problem = entryValueProblem(field, draft.values[field.id] ?? null);
    if (problem) errors[field.id] = problem;
  }
  return errors;
}

/**
 * One active row draft with debounced, revision-safe persistence.
 *
 * Inputs stay enabled while requests are in flight. A response only advances
 * the saved base/revision; newer local values remain in the draft and are
 * queued for the next write instead of being overwritten by the response.
 *
 * A new row is created as soon as it opens (so the server assigns its id and
 * created_at) unless a required field without a default needs a value first.
 * `close` ends cell editing; the draft is dropped once its last save lands.
 */
export function useEntryDraft(
  tableId: string,
  onSaved: (entry: TableEntry, created: boolean, beforeEntryId?: string) => void
) {
  const [draft, setDraft] = useState<EntryDraft | null>(null);
  const [saveState, setSaveState] = useState<EntrySaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);
  const reloadPending = useRef(false);
  const optionPending = useRef(false);
  const latest = useRef(draft);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedFade = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);
  const queued = useRef(false);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const transitions = useRef<Promise<boolean>>(Promise.resolve(true));
  const transitionEpoch = useRef(0);
  const saveSequence = useRef(0);
  const savedEntries = useRef(new Map<string, { entry: TableEntry; sequence: number }>());
  const mounted = useRef(true);
  latest.current = draft;

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const setCurrent = (next: EntryDraft | null) => {
    latest.current = next;
    setDraft(next);
  };

  const showSaved = () => {
    if (!mounted.current) return;
    if (savedFade.current) clearTimeout(savedFade.current);
    setSaveState('saved');
    // Fade only "Saved": a newer edit's status (waiting, saving, failed) stays.
    savedFade.current = setTimeout(
      () => setSaveState((state) => (state === 'saved' ? 'idle' : state)),
      SAVED_FADE_MS
    );
  };

  async function persistLatest(): Promise<boolean> {
    clearTimer();
    if (reloadPending.current) return false;
    const current = latest.current;
    if (!current) return true;
    if (saving.current) {
      queued.current = true;
      return (await inFlight.current) ?? false;
    }

    const errors = validationErrors(current);
    setFieldErrors(errors);
    if (Object.keys(errors).length) {
      setSaveState('dirty');
      return false;
    }

    const write = changedValues(current);
    if (current.original && !Object.keys(write).length) {
      // Nothing was written, so there is nothing to report as saved.
      setSaveState((state) => (state === 'dirty' ? 'idle' : state));
      return true;
    }

    const wasCreated = !current.original;
    saving.current = true;
    setSaveState('saving');
    setError(null);
    setConflict(false);
    const request = (async () => {
      try {
        const result = current.original
          ? await tablesApi.updateEntry(tableId, current.id, {
              values: write,
              schemaVersion: current.schemaVersion,
              expectedRevision: current.original.revision,
            })
          : await tablesApi.createEntry(tableId, {
              id: current.id,
              values: write,
              schemaVersion: current.schemaVersion,
              ...(current.beforeEntryId ? { beforeEntryId: current.beforeEntryId } : {}),
            });
        if (current.original)
          void noteRepeatAdvance({
            tableId,
            fields: current.fields,
            before: current.original,
            after: result.entry,
            patch: write,
          });
        // Queued opens may still carry pre-save rows from their DOM event.
        savedEntries.current.set(result.entry.id, {
          entry: result.entry,
          sequence: ++saveSequence.current,
        });
        // The saved row reaches the grid even if the user already moved on.
        emitTableEvent({ type: 'table.entries.changed', tableId, entryId: result.entry.id });
        onSaved(result.entry, wasCreated, current.beforeEntryId);
        const newest = latest.current;
        if (!newest || newest.id !== current.id) return true;
        const changedWhileSaving = newest.fields.some(
          (field) =>
            !field.managed &&
            !sameValue(newest.values[field.id] ?? null, current.values[field.id] ?? null, field)
        );
        // A closed row with nothing left to write goes back to server data.
        const settled = !changedWhileSaving && !queued.current && !newest.focusFieldId;
        // The saved row can differ from what was sent: a done status advances
        // a repeating date and resets the status. Values not edited while this
        // save was out take the saved row's, so the draft never writes the
        // previous ones back.
        const values = { ...newest.values };
        for (const field of newest.fields)
          if (
            !field.managed &&
            sameValue(newest.values[field.id] ?? null, current.values[field.id] ?? null, field)
          )
            values[field.id] = result.entry.values[field.id] ?? null;
        setCurrent(
          settled
            ? null
            : { ...newest, values, original: result.entry, schemaVersion: result.schemaVersion }
        );
        setFieldErrors({});
        if (changedWhileSaving) {
          queued.current = true;
          setSaveState('dirty');
        } else {
          showSaved();
        }
        return true;
      } catch (err) {
        // Escape can discard this draft while its request is still running.
        if (latest.current?.id !== current.id) return false;
        setError(getErrorMessage(err, 'Could not autosave this row'));
        setConflict(err instanceof FetchError && err.status === 409);
        setSaveState('error');
        return false;
      } finally {
        saving.current = false;
      }
    })();
    inFlight.current = request;
    const result = await request;
    inFlight.current = null;
    if (queued.current && result) {
      queued.current = false;
      if (!mounted.current) return persistLatest();
      timer.current = setTimeout(() => {
        timer.current = null;
        void persistLatest();
      }, 0);
    }
    return result;
  }

  const queueSave = () => {
    clearTimer();
    setSaveState((state) => (state === 'saving' ? state : 'dirty'));
    if (saving.current) {
      queued.current = true;
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      void persistLatest();
    }, SAVE_DELAY_MS);
  };

  function begin(
    entry: TableEntry | null,
    fields: TableField[],
    schemaVersion: string,
    focusFieldId?: string,
    options: BeginOptions = {}
  ): Promise<boolean> {
    if (reloadPending.current) return Promise.resolve(false);
    const epoch = transitionEpoch.current;
    const requestedAt = saveSequence.current;
    const resolveEntry = () => {
      const saved = savedEntries.current.get(entry?.id ?? options.draftId ?? '');
      return saved && (saved.sequence > requestedAt || (!entry && options.draftId))
        ? saved.entry
        : entry;
    };
    const open = async (): Promise<boolean> => {
      if (epoch !== transitionEpoch.current) return false;
      // Escape discards the draft, not a request already sent to the server.
      // Reopening must adopt that response before taking another editable base.
      if (!latest.current && inFlight.current) {
        await inFlight.current;
        if (epoch !== transitionEpoch.current) return false;
      }
      const current = latest.current;
      // A queued drop into an unsaved row names that row, not the ghost.
      // If it has since left the draft, never turn the drop into another insert.
      if (options.draftId && !resolveEntry() && current?.id !== options.draftId) return false;
      const sameRow = current && current.id === (entry?.id ?? options.draftId);
      if (current && !sameRow) {
        if (!(await flush())) {
          focusFirstInvalid();
          return false;
        }
        if (epoch !== transitionEpoch.current) return false;
        clearDraft();
      }
      startDraft(resolveEntry(), fields, schemaVersion, focusFieldId, options);
      return true;
    };
    // Accepted drops are ordered: a slow save must not let a later open
    // cancel a newer draft or insert into whichever row happens to be active.
    const transition = transitions.current.then(open, open);
    transitions.current = transition;
    return transition;
  }

  function startDraft(
    entry: TableEntry | null,
    fields: TableField[],
    schemaVersion: string,
    focusFieldId: string | undefined,
    options: BeginOptions
  ) {
    const current = latest.current;
    const target = focusFieldId ?? fields.find((field) => !field.managed)?.id;
    const focusTarget = options.editCell === false ? undefined : target;
    if (current && current.id === (entry?.id ?? options.draftId)) {
      setCurrent({
        ...current,
        focusFieldId: focusTarget,
        editorGeneration: current.editorGeneration + (current.focusFieldId === target ? 0 : 1),
      });
      if (target && options.updateValue)
        change(target, options.updateValue(current.values[target] ?? null));
      return;
    }
    setError(null);
    setConflict(false);
    setFieldErrors({});
    setSaveState('idle');
    const next: EntryDraft = {
      id: entry?.id ?? crypto.randomUUID(),
      original: entry ?? undefined,
      values: entry ? { ...entry.values } : newEntryValues(fields),
      fields,
      schemaVersion,
      focusFieldId: focusTarget,
      editorGeneration: 0,
      ...(entry ? {} : { beforeEntryId: options.beforeEntryId }),
    };
    if (target && options.updateValue)
      next.values[target] = options.updateValue(next.values[target] ?? null);
    setCurrent(next);
    // Create the row now unless a required field still needs a value; that
    // row saves on its first valid edit instead.
    if (!entry && !Object.keys(validationErrors(next)).length) {
      clearTimer();
      timer.current = setTimeout(() => {
        timer.current = null;
        void persistLatest();
      }, 0);
    } else if (options.updateValue) {
      queueSave();
    }
  }

  function focus(fieldId: string) {
    const current = latest.current;
    if (!current) return;
    setCurrent({
      ...current,
      focusFieldId: fieldId,
      editorGeneration: current.editorGeneration + 1,
    });
  }

  function change(fieldId: string, value: TableEntryValue) {
    if (reloadPending.current) return;
    const current = latest.current;
    if (
      !current ||
      sameValue(
        current.values[fieldId] ?? null,
        value,
        current.fields.find((field) => field.id === fieldId)
      )
    )
      return;
    setCurrent({ ...current, values: { ...current.values, [fieldId]: value } });
    setFieldErrors((errors) => {
      const nextErrors = { ...errors };
      delete nextErrors[fieldId];
      return nextErrors;
    });
    setError(null);
    setConflict(false);
    queueSave();
  }

  /**
   * Add a Select label to the open cell from the latest draft rather than a
   * render snapshot. False when that cell has closed or changed rows.
   */
  function chooseSelectLabel(draftId: string, fieldId: string, label: string): boolean {
    const current = latest.current;
    const field = current?.fields.find((item) => item.id === fieldId);
    if (!current || current.id !== draftId || current.focusFieldId !== fieldId) return false;
    if (field?.type !== 'select') return false;
    const labels = entryValueList(current.values[fieldId] ?? null);
    if (labels.some((value) => value.toLowerCase() === label.toLowerCase())) return true;
    change(fieldId, field.multiple ? [...labels, label] : label);
    return true;
  }

  function cancel() {
    transitionEpoch.current += 1;
    // Already-sent writes still update the grid; unsent edits and queued opens
    // must not survive Escape and become a second write afterward.
    clearDraft();
  }

  function clearDraft() {
    clearTimer();
    queued.current = false;
    setCurrent(null);
    setError(null);
    setConflict(false);
    setFieldErrors({});
    setSaveState('idle');
  }

  async function flush(): Promise<boolean> {
    const id = latest.current?.id;
    // Drain edits made during a request before allowing a row switch. A
    // successful first response alone does not mean the draft is saved.
    while (latest.current?.id === id && latest.current) {
      clearTimer();
      if (saving.current && inFlight.current) {
        if (!(await inFlight.current)) return false;
        continue;
      }
      queued.current = false;
      if (!(await persistLatest())) return false;
      const current = latest.current;
      if (!current || current.id !== id || !Object.keys(changedValues(current)).length) return true;
    }
    return true;
  }

  /**
   * Leave the active cell: save what is pending, then drop the draft so the
   * row shows server data again. An invalid value keeps its cell open.
   */
  async function close(): Promise<void> {
    const current = latest.current;
    if (!current?.focusFieldId) return;
    setCurrent({ ...current, focusFieldId: undefined });
    const saved = await flush();
    const after = latest.current;
    // The user may have opened another cell (or row) while this one saved.
    if (!after || after.id !== current.id || after.focusFieldId !== undefined) return;
    if (!saved) {
      // Keep a failed edit in front of the user: its invalid cell, or this one.
      if (!focusFirstInvalid()) focus(current.focusFieldId);
      return;
    }
    if (!saving.current && !timer.current && !queued.current) setCurrent(null);
  }

  /**
   * A write outside the draft saved its row (a repeat action from a date's
   * picker): take `entry` as the base, so the next save isn't stale. Cells
   * edited here keep their edit, except `fieldId`, the date that write was
   * about, which shows what the server made of it.
   */
  function adopt(entry: TableEntry, fieldId?: string) {
    const current = latest.current;
    if (!current?.original || current.id !== entry.id) return;
    const values = { ...current.values };
    for (const field of current.fields) {
      const edited = !sameValue(
        current.values[field.id] ?? null,
        current.original.values[field.id] ?? null,
        field
      );
      if (field.id === fieldId || !edited) values[field.id] = entry.values[field.id] ?? null;
    }
    setCurrent({ ...current, original: entry, values });
  }

  /** Reopen the first cell whose value blocks saving; false when none does. */
  function focusFirstInvalid(): boolean {
    const current = latest.current;
    const invalid = current?.fields.find(
      (field) => !field.managed && entryValueProblem(field, current.values[field.id] ?? null)
    );
    if (invalid) focus(invalid.id);
    return !!invalid;
  }

  async function reloadLatest() {
    const current = latest.current;
    if (!current || saving.current || reloadPending.current || optionPending.current) return;
    const epoch = transitionEpoch.current;
    clearTimer();
    queued.current = false;
    reloadPending.current = true;
    setReloading(true);
    saving.current = true;
    setSaveState('saving');
    setError(null);
    try {
      const page = await tablesApi.entries(tableId, { page: 1, pageSize: 1 });
      let entry: TableEntry | undefined;
      try {
        entry = (await tablesApi.entry(tableId, current.id)).entry;
      } catch (err) {
        if (current.original || !(err instanceof FetchError && err.status === 404)) throw err;
      }
      if (epoch !== transitionEpoch.current || latest.current?.id !== current.id) return;
      setCurrent({
        ...current,
        original: entry,
        values: entry ? { ...entry.values } : newEntryValues(page.fields),
        fields: page.fields,
        schemaVersion: page.schemaVersion,
        editorGeneration: current.editorGeneration + 1,
      });
      setConflict(false);
      setFieldErrors({});
      showSaved();
    } catch (err) {
      if (epoch !== transitionEpoch.current || latest.current?.id !== current.id) return;
      setError(getErrorMessage(err, 'Could not reload this row'));
      setSaveState('error');
    } finally {
      reloadPending.current = false;
      setReloading(false);
      saving.current = false;
    }
  }

  /** Schema writes must settle and refresh the draft before its first option value is written. */
  async function addSelectOption(fieldId: string, label: string) {
    const starting = latest.current;
    if (!starting || optionPending.current || reloadPending.current) return null;
    const epoch = transitionEpoch.current;
    const isCurrent = () =>
      mounted.current &&
      epoch === transitionEpoch.current &&
      latest.current?.id === starting.id &&
      latest.current.focusFieldId === fieldId &&
      latest.current.editorGeneration === starting.editorGeneration;
    optionPending.current = true;
    setReloading(true);
    let saveRejected = false;
    try {
      // Save valid choices already made in this cell. An incomplete required
      // ghost row must still be able to create the option that will complete it.
      if (!Object.keys(validationErrors(starting)).length && !(await flush())) {
        saveRejected = true;
        throw new Error('Save or discard this edit before creating an option.');
      }
      if (inFlight.current && !(await inFlight.current)) {
        saveRejected = true;
        throw new Error('Save or discard this edit before creating an option.');
      }
      if (!isCurrent()) return null;
      clearTimer();
      queued.current = false;
      reloadPending.current = true;
      const created = await createSelectOption(tableId, fieldId, label);
      emitTableEvent({ type: 'table.fields.changed', tableId });
      if (!isCurrent()) return null;
      const page = await tablesApi.entries(tableId, { page: 1, pageSize: 1 });
      const current = latest.current;
      if (!isCurrent() || !current) return null;
      let entry: TableEntry | undefined;
      try {
        entry = (await tablesApi.entry(tableId, current.id)).entry;
      } catch (err) {
        if (current.original || !(err instanceof FetchError && err.status === 404)) throw err;
      }
      if (!isCurrent()) return null;
      const refreshed = page.fields.find((field) => field.id === fieldId);
      const option = refreshed?.options?.find((item) => item.id === created.option.id);
      if (!refreshed || refreshed.type !== 'select' || !option)
        throw new Error('The option changed while it was being created. Try again.');
      const pending = changedValues(current);
      for (const [id] of Object.entries(pending)) {
        const field = page.fields.find((item) => item.id === id && !item.managed);
        if (
          !field ||
          (current.original &&
            entry &&
            !sameValue(current.original.values[id] ?? null, entry.values[id] ?? null, field))
        )
          throw new FetchError(
            'This row changed while creating the option. Load the latest row before continuing.',
            409
          );
      }
      setCurrent({
        ...current,
        original: entry,
        values: { ...(entry?.values ?? newEntryValues(page.fields)), ...pending },
        fields: page.fields,
        schemaVersion: page.schemaVersion,
      });
      if (entry) onSaved(entry, false);
      setError(null);
      setConflict(false);
      setFieldErrors({});
      setSaveState(Object.keys(pending).length ? 'dirty' : 'idle');
      return { option, fields: page.fields };
    } catch (err) {
      if (isCurrent() && !saveRejected) {
        setError(getErrorMessage(err, 'Could not create this option'));
        setConflict(err instanceof FetchError && err.status === 409);
        setSaveState('error');
      }
      throw err;
    } finally {
      optionPending.current = false;
      reloadPending.current = false;
      if (mounted.current) setReloading(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      transitionEpoch.current += 1;
      clearTimer();
      if (savedFade.current) clearTimeout(savedFade.current);
      const current = latest.current;
      // Navigation must not drop accepted edits just because their debounce
      // has not elapsed. An in-flight save drains its newer values afterward.
      if (
        current &&
        !reloadPending.current &&
        (!current.original || Object.keys(changedValues(current)).length)
      ) {
        void persistLatest();
      }
    };
  }, []);

  return {
    draft,
    saving: saveState === 'saving',
    reloading,
    saveState,
    error,
    fieldErrors,
    conflict,
    begin,
    focus,
    change,
    cancel,
    close,
    flush,
    reloadLatest,
    addSelectOption,
    chooseSelectLabel,
    focusFirstInvalid,
    adopt,
  };
}
