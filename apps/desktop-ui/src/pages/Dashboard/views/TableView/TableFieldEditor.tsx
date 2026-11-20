import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FC,
  type RefObject,
} from 'react';
import {
  EDITABLE_TABLE_FIELD_TYPES,
  TABLE_FIELD_DESCRIPTION_MAX_LENGTH,
  type EditableTableFieldType,
  type TableField,
  type TableFieldDefinition,
} from '@snaglet/shared/types';
import {
  formatTableName,
  generateId,
  getErrorMessage,
  tableDateTimeLocalDate,
  tableFieldDefinitionProblem,
  userTimeZone,
} from '@snaglet/shared/utils';
import { Button, DateInput, OptionToggle, OptionToggleRow, Select } from '@desktop/components';
import { emitTableEvent, useTableCatalog } from '@desktop/features/database';
import { useDebouncedSave } from '@desktop/pages/Dashboard/hooks/useDebouncedSave';
import { FetchError, tablesApi } from '@desktop/utils/api';
import { useChipDropTarget } from '@desktop/utils/nodeChip';
import { TableInput } from './TableInput';
import { RelationTargetSettings } from './RelationTargetSettings';
import { SelectFieldSettings } from './SelectFieldSettings';
import { reconcileSelectOptions } from './selectFieldDefinition';
import { fromDateTimeInput, toDateTimeInput } from './dateTimeInput';
import { bindingOf, bindingUndoStep } from '@desktop/features/calendar/bindField';
import { offerUndo } from '@desktop/features/calendar/calendarUndo';
import { getCalendarsSnapshot, loadCalendars } from '@desktop/features/calendar/calendarStore';
import { CalendarSection } from './fieldEditor/CalendarSection';
import { RepeatsSection } from './fieldEditor/RepeatsSection';
import { useTableFields } from './fieldEditor/useTableFields';
import {
  bindingChangeMessage,
  isDateType,
  repeatProblem,
  shownCalendarId,
  shownRecurrence,
  statusFieldsOf,
  stripForType,
} from './fieldEditor/fieldEditorDraft';
import styles from './TableFieldEditor.module.scss';
import fieldEditorStyles from './fieldEditor/fieldEditor.module.scss';

const FIELD_TYPE_LABELS: Record<Exclude<EditableTableFieldType, 'datetime'>, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  checkbox: 'Checkbox',
  relation: 'Relation',
  select: 'Select',
};

function definition(field?: TableField): TableFieldDefinition {
  return {
    name: field?.name ?? '',
    description: field?.description ?? null,
    type:
      field && EDITABLE_TABLE_FIELD_TYPES.some((type) => type === field.type)
        ? (field.type as EditableTableFieldType)
        : 'text',
    nullable: field?.nullable ?? true,
    defaultValue: field?.defaultValue ?? null,
    referenceTableId: field?.referenceTableId ?? null,
    referenceKind: field?.type === 'relation' ? field.referenceKind : null,
    multiple: field?.multiple ?? false,
    range: field?.range ?? false,
    ...(field?.type === 'select' ? { options: field.options ?? [] } : {}),
  };
}

interface Props {
  tableId: string;
  field?: TableField;
  beforeFieldId?: string;
  returnFocusTo?: HTMLElement | (() => HTMLElement | null);
  onRestoreFocus?: () => void;
  onPersisted?: (field: TableField) => void;
  requestCloseRef?: RefObject<(() => void) | null>;
  onClose: () => void;
}

/** Field settings opened from a header and persisted without a Save action. */
export const TableFieldEditor: FC<Props> = ({
  tableId,
  field,
  beforeFieldId,
  returnFocusTo,
  onRestoreFocus,
  onPersisted,
  requestCloseRef,
  onClose,
}) => {
  const [draft, setDraft] = useState(() => definition(field));
  const draftRef = useRef(draft);
  const fieldRef = useRef(field);
  const revisionRef = useRef(field?.revision);
  const [createId] = useState(() => generateId('field'));
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const staleRef = useRef(false);
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [optionsGeneration, setOptionsGeneration] = useState(0);
  const loadingLatestRef = useRef(false);
  const [dismissBlocked, setDismissBlocked] = useState(false);
  // Set when a saved field's times or end dates are switched off; the warning
  // stays after the save, since undo is how they come back.
  const [droppedTimes, setDroppedTimes] = useState(false);
  const [droppedEnds, setDroppedEnds] = useState(false);
  const timedDefault = useRef<{ instant: string; date: string } | null>(null);
  const touched = useRef(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  const closing = useRef(false);
  const editVersion = useRef(0);
  const savedVersion = useRef(0);
  const closeAfterSave = useRef(false);
  const requiredChoice = useRef<boolean | undefined>(undefined);
  const flushOptions = useRef<(() => boolean) | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const dismissNoticeRef = useRef<HTMLDivElement>(null);
  const focusTarget = useRef(returnFocusTo);
  focusTarget.current = returnFocusTo;
  const restoreFocus = useRef(onRestoreFocus);
  restoreFocus.current = onRestoreFocus;
  const headingId = useId();
  const typeId = useId();
  const typeReasonId = useId();
  const defaultId = useId();
  const timesWarningId = useId();
  const endsWarningId = useId();
  const tableFields = useTableFields(tableId, isDateType(draft.type));
  const tableFieldsRef = useRef(tableFields);
  tableFieldsRef.current = tableFields;
  const catalog = useTableCatalog(draft.type === 'relation');
  const customTables = catalog.tables?.filter((table) => table.origin === 'custom') ?? [];
  const { dropTargetProps: datetimeDropTarget } = useChipDropTarget({
    triggerMode: 'always',
    enabled: draft.type === 'datetime',
    onAccept: () => setError('Date defaults cannot contain links.'),
  });

  /** The repeat checks (client mirror of the server's) first, then the shared definition policy. */
  const definitionProblem = (value: TableFieldDefinition): string | null =>
    repeatProblem(value, fieldRef.current, tableFieldsRef.current) ??
    tableFieldDefinitionProblem(value);

  const normalize = ({
    referenceKind,
    range,
    ...value
  }: TableFieldDefinition): TableFieldDefinition => {
    const targetText = value.referenceTableId?.trim() ?? '';
    const matches = customTables.filter(
      (table) => table.id === targetText || table.name.toLowerCase() === targetText.toLowerCase()
    );
    return stripForType({
      ...value,
      // A relation always names its Snaglet item kind (null for a table target);
      // other types leave it out, and the server clears it.
      ...(value.type === 'relation' ? { referenceKind: referenceKind ?? null } : {}),
      // Only dates send End date (left out = keep); a range has no default.
      ...(isDateType(value.type)
        ? { range: !!range, ...(range ? { defaultValue: null } : {}) }
        : {}),
      name: value.name.trim(),
      description: value.description?.trim() || null,
      ...(value.type === 'relation'
        ? { nullable: !value.multiple, defaultValue: value.multiple ? [] : null }
        : value.type === 'select'
          ? {
              multiple: !!value.multiple,
              options: value.options ?? [],
              ...(value.multiple
                ? { nullable: false, defaultValue: value.defaultValue ?? [] }
                : {}),
            }
          : { multiple: false }),
      referenceTableId:
        value.type === 'relation' && !referenceKind && matches.length === 1
          ? matches[0].id
          : value.referenceTableId,
    });
  };

  const normalized = normalize(draft);
  const problem = definitionProblem(normalized);
  const descriptionTooLong = (draft.description?.length ?? 0) > TABLE_FIELD_DESCRIPTION_MAX_LENGTH;

  function finishClose() {
    if (closing.current || !mounted.current) return;
    closing.current = true;
    onClose();
  }

  async function persist() {
    if (busy.current || closing.current) return;
    if (!mounted.current && flushOptions.current && !flushOptions.current())
      throw new Error('Finish editing the option before saving.');
    if (!touched.current) return;
    if (staleRef.current || loadingLatestRef.current)
      throw new Error('Load the latest field before saving again.');
    const savingVersion = editVersion.current;
    if (fieldRef.current && savingVersion === savedVersion.current) return;
    const next = normalize(draftRef.current);
    const nextProblem = definitionProblem(next);
    if (nextProblem) {
      if (mounted.current) {
        setError(nextProblem);
        setDismissBlocked(closeAfterSave.current);
      }
      closeAfterSave.current = false;
      throw new Error(nextProblem);
    }
    busy.current = true;
    if (mounted.current) setError(null);
    try {
      const currentField = fieldRef.current;
      const currentRevision = revisionRef.current;
      const result =
        currentField && currentRevision !== undefined
          ? await tablesApi.updateField(tableId, currentField.id, {
              ...next,
              expectedRevision: currentRevision,
            })
          : await tablesApi.createField(tableId, {
              ...next,
              id: createId,
              ...(beforeFieldId ? { beforeFieldId } : {}),
            });
      fieldRef.current = result.field;
      revisionRef.current = result.field.revision;
      savedVersion.current = savingVersion;
      afterCalendarSave(currentField, result.field, savingVersion);
      if (
        next.type === 'select' &&
        result.field.type === 'select' &&
        draftRef.current.type === 'select'
      ) {
        const current = draftRef.current;
        const reconciled = reconcileSelectOptions(
          { options: next.options ?? [], defaultValue: next.defaultValue },
          { options: current.options ?? [], defaultValue: current.defaultValue },
          { options: result.field.options ?? [], defaultValue: result.field.defaultValue }
        );
        draftRef.current = { ...current, ...reconciled };
        if (mounted.current) setDraft(draftRef.current);
      }
      if (mounted.current) {
        setDismissBlocked(false);
        onPersisted?.(result.field);
      }
      emitTableEvent({ type: 'table.fields.changed', tableId });
      if (closeAfterSave.current && savingVersion === editVersion.current) {
        closeAfterSave.current = false;
        finishClose();
      }
    } catch (err) {
      if (mounted.current) {
        setDismissBlocked(closeAfterSave.current);
        setError(getErrorMessage(err, 'Could not autosave this field'));
      }
      closeAfterSave.current = false;
      if (
        fieldRef.current &&
        err instanceof FetchError &&
        err.status === 409 &&
        typeof err.details === 'object' &&
        err.details !== null &&
        'field' in err.details
      ) {
        staleRef.current = true;
        if (mounted.current) setStale(true);
      }
      throw err;
    } finally {
      busy.current = false;
    }
  }

  const autosave = useDebouncedSave(persist, {
    delayMs: 450,
    savedFadeMs: 1400,
    flushOnUnmount: true,
  });

  const patch = (value: Partial<TableFieldDefinition>) => {
    if (staleRef.current || loadingLatestRef.current || closing.current) return;
    const keys = Object.keys(value) as Array<keyof TableFieldDefinition>;
    if (keys.every((key) => Object.is(value[key], draftRef.current[key]))) return;
    const next = { ...draftRef.current, ...value };
    draftRef.current = next;
    touched.current = true;
    editVersion.current += 1;
    if (mounted.current) {
      setDraft(next);
      setError(null);
      setDismissBlocked(false);
    }
    // New fields stay local until committed, so choosing a type/default never
    // races a premature Text-column creation. Existing fields still autosave.
    if (mounted.current) {
      if (fieldRef.current || busy.current) autosave.queueSave();
      else autosave.setSaveState('dirty');
    }
  };

  const changeIncludeTime = (includeTime: boolean) => {
    const previous = draftRef.current;
    const timed = timedDefault.current;
    timedDefault.current = null;
    let defaultValue = previous.defaultValue;
    if (includeTime) {
      // Time back on before anything else changed the default: the exact instant returns.
      if (timed && Object.is(timed.date, previous.defaultValue)) defaultValue = timed.instant;
    } else if (typeof previous.defaultValue === 'string') {
      defaultValue =
        tableDateTimeLocalDate(previous.defaultValue, userTimeZone()) ?? previous.defaultValue;
      timedDefault.current = { instant: previous.defaultValue, date: defaultValue };
    }
    setDroppedTimes(!includeTime && fieldRef.current?.type === 'datetime');
    patch({ type: includeTime ? 'datetime' : 'date', defaultValue });
  };

  const changeEndDate = (range: boolean) => {
    setDroppedEnds(!range && !!fieldRef.current?.range);
    patch({ range, ...(range ? { defaultValue: null } : {}) });
  };

  /**
   * After a save: a binding change made on an existing field goes on the
   * calendar undo stack as the same reverse binding write the sidebar bind uses (table
   * history does not record bindings). A create has no calendar step: undoing
   * the create (table history) removes the field and its binding with it.
   * Saved binding/repeat keys then leave the draft, so later saves don't
   * re-send them and the shown values follow the saved field.
   */
  function afterCalendarSave(
    before: TableField | undefined,
    saved: TableField,
    savingVersion: number
  ) {
    if ('calendarId' in draftRef.current || before?.calendarId !== saved.calendarId)
      void loadCalendars();
    // A retype that cleared the binding is not undone here (the reverse write would not fit the new type).
    if (before && isDateType(saved.type) && before.type === saved.type) {
      const previous = bindingOf(before);
      const message = bindingChangeMessage(
        saved.name,
        previous.calendarId,
        saved.calendarId ?? null,
        (id) => getCalendarsSnapshot().calendars?.find((c) => c.id === id)?.title ?? 'a calendar'
      );
      if (message) offerUndo(message, bindingUndoStep(tableId, saved, previous, message));
    }
    if (savingVersion !== editVersion.current) return;
    const { calendarId: _calendar, recurrence: _recurrence, ...rest } = draftRef.current;
    if (Object.keys(rest).length === Object.keys(draftRef.current).length) return;
    draftRef.current = rest;
    if (mounted.current) setDraft(rest);
  }

  const close = () => {
    if (closing.current) return;
    if (flushOptions.current && !flushOptions.current()) return;
    if (loadingLatestRef.current) {
      setDismissBlocked(true);
      dismissNoticeRef.current?.focus();
      return;
    }
    if (busy.current) {
      closeAfterSave.current = true;
      void autosave.flush();
      return;
    }
    if (!touched.current) {
      finishClose();
      return;
    }
    const currentProblem = definitionProblem(normalize(draftRef.current));
    if (currentProblem || autosave.saveState === 'error' || stale) {
      if (currentProblem) setError(currentProblem);
      setDismissBlocked(true);
      dismissNoticeRef.current?.focus();
      return;
    }
    if (editVersion.current !== savedVersion.current) {
      closeAfterSave.current = true;
      void autosave.flush();
      return;
    }
    finishClose();
  };
  useLayoutEffect(() => {
    if (!requestCloseRef) return;
    requestCloseRef.current = close;
    return () => {
      requestCloseRef.current = null;
    };
  });

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Capture child-local label text before an in-flight response reconciles
      // assigned/discovered options. The passive cleanup then drains the save.
      flushOptions.current?.();
    };
  }, []);

  useLayoutEffect(() => {
    if (dismissBlocked) dismissNoticeRef.current?.focus();
  }, [dismissBlocked]);

  async function loadLatest() {
    const currentField = fieldRef.current;
    if (!currentField || busy.current) return;
    busy.current = true;
    loadingLatestRef.current = true;
    setLoadingLatest(true);
    autosave.cancelPending();
    setError(null);
    try {
      const { fields } = await tablesApi.fields(tableId);
      const latest = fields.find((item) => item.id === currentField.id);
      if (!latest || latest.managed) throw new Error('This field is no longer editable.');
      if (!mounted.current) return;
      const next = definition(latest);
      flushOptions.current = null;
      setOptionsGeneration((generation) => generation + 1);
      draftRef.current = next;
      fieldRef.current = latest;
      revisionRef.current = latest.revision;
      setDraft(next);
      setDroppedTimes(false);
      setDroppedEnds(false);
      timedDefault.current = null;
      editVersion.current = 0;
      savedVersion.current = 0;
      closeAfterSave.current = false;
      setStale(false);
      staleRef.current = false;
      setDismissBlocked(false);
      touched.current = false;
      requiredChoice.current = undefined;
      autosave.setSaveState('idle');
      emitTableEvent({ type: 'table.fields.changed', tableId });
    } catch (err) {
      if (mounted.current) {
        setError(getErrorMessage(err, 'Could not reload this field'));
        autosave.setSaveState('error');
      }
    } finally {
      busy.current = false;
      loadingLatestRef.current = false;
      if (mounted.current) setLoadingLatest(false);
    }
  }

  useEffect(() => {
    const previous = document.activeElement;
    const panel = panelRef.current;
    return () => {
      if (!panel?.contains(document.activeElement) && document.activeElement !== document.body)
        return;
      if (restoreFocus.current) {
        restoreFocus.current();
        return;
      }
      const target = focusTarget.current;
      const current = (typeof target === 'function' ? target() : target) ?? previous;
      if (current instanceof HTMLElement && current.isConnected) {
        current.focus({ preventScroll: true });
      }
    };
  }, []);

  const relation = draft.type === 'relation';
  const inputDisabled = stale || loadingLatest;
  const timesWarningShown = droppedTimes && draft.type === 'date';
  const endsWarningShown = droppedEnds && isDateType(draft.type) && !draft.range;
  const isTitle = fieldRef.current?.isTitle ?? false;
  return (
    <section
      ref={panelRef}
      className={styles.panel}
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          void close();
        }
      }}
    >
      <h2 id={headingId} className={styles.heading}>
        {fieldRef.current ? 'Field settings' : 'New field'}
      </h2>
      <div className={styles.body}>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (flushOptions.current && !flushOptions.current()) return;
            void autosave.flush();
          }}
        >
          <div
            onBlur={(event) => {
              // Moving to Type/Required/Default is still configuring this field.
              if (
                !fieldRef.current &&
                touched.current &&
                !panelRef.current?.contains(event.relatedTarget)
              )
                void autosave.flush();
            }}
          >
            <TableInput
              autoFocus
              onEscape={close}
              label="Field name"
              value={draft.name}
              placeholder="column_name"
              format={formatTableName}
              disabled={inputDisabled}
              onChange={(name) => patch({ name })}
              onSubmit={() => void autosave.flush()}
            />
          </div>
          <div className={styles.control}>
            <label htmlFor={typeId}>Field type</label>
            <Select
              id={typeId}
              className={styles.typeSelect}
              value={draft.type === 'datetime' ? 'date' : draft.type}
              disabled={inputDisabled || isTitle}
              aria-describedby={isTitle ? typeReasonId : undefined}
              onChange={(event) => {
                const type = event.target.value as EditableTableFieldType;
                const previous = draftRef.current;
                const previousOption = previous.type === 'datetime' ? 'date' : previous.type;
                if (inputDisabled || isTitle || type === previousOption) return;
                setDroppedTimes(false);
                setDroppedEnds(false);
                if (previous.type === 'select') {
                  if (flushOptions.current && !flushOptions.current()) return;
                  flushOptions.current = null;
                }
                const inheritedRequired =
                  previous.type === 'checkbox' ||
                  ((previous.type === 'relation' || previous.type === 'select') &&
                    previous.multiple);
                patch({
                  type,
                  defaultValue: type === 'checkbox' ? false : null,
                  referenceTableId: null,
                  referenceKind: null,
                  multiple: false,
                  range: false,
                  ...(type === 'select'
                    ? { options: [] }
                    : previous.type === 'select'
                      ? { options: null }
                      : {}),
                  ...(type === 'checkbox'
                    ? { nullable: false }
                    : type === 'relation'
                      ? { nullable: true }
                      : {
                          nullable:
                            requiredChoice.current !== undefined
                              ? !requiredChoice.current
                              : inheritedRequired
                                ? true
                                : previous.nullable,
                        }),
                });
              }}
            >
              {EDITABLE_TABLE_FIELD_TYPES.filter((type) => type !== 'datetime').map((type) => (
                <option key={type} value={type}>
                  {FIELD_TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
            {isTitle && (
              <p id={typeReasonId} className={styles.note}>
                This field names each entry and must stay Text.
              </p>
            )}
          </div>
          {!relation && draft.type !== 'select' && (
            <>
              <OptionToggleRow aria-label="Field options">
                {isDateType(draft.type) && (
                  <>
                    <OptionToggle
                      aria-describedby={timesWarningShown ? timesWarningId : undefined}
                      pressed={draft.type === 'datetime'}
                      disabled={inputDisabled || isTitle}
                      onChange={changeIncludeTime}
                    >
                      Include time
                    </OptionToggle>
                    <OptionToggle
                      aria-describedby={endsWarningShown ? endsWarningId : undefined}
                      pressed={!!draft.range}
                      disabled={inputDisabled || isTitle}
                      onChange={changeEndDate}
                    >
                      End date
                    </OptionToggle>
                  </>
                )}
                <OptionToggle
                  pressed={!draft.nullable}
                  disabled={inputDisabled}
                  onChange={(required) => {
                    requiredChoice.current = required;
                    patch({ nullable: !required });
                  }}
                >
                  Required
                </OptionToggle>
                {!(isDateType(draft.type) && draft.range) && (
                  <OptionToggle
                    pressed={draft.defaultValue !== null}
                    disabled={inputDisabled}
                    onChange={(on) =>
                      patch({
                        defaultValue: on ? (draft.type === 'checkbox' ? false : '') : null,
                      })
                    }
                  >
                    Default
                  </OptionToggle>
                )}
              </OptionToggleRow>
              {isDateType(draft.type) &&
                fieldRef.current?.recurrence &&
                fieldRef.current.type !== draft.type && (
                  <p className={fieldEditorStyles.warning} role="status">
                    Changing this removes every row’s repeat (a repeat is set for a day or a time).
                    Undo brings them back.
                  </p>
                )}
              {timesWarningShown && (
                <p id={timesWarningId} className={fieldEditorStyles.warning} role="status">
                  {draft.range
                    ? 'Removing times keeps each row’s dates.'
                    : 'Removing times keeps each row’s date.'}{' '}
                  Undo brings them back.
                </p>
              )}
              {endsWarningShown && (
                <p id={endsWarningId} className={fieldEditorStyles.warning} role="status">
                  Removing end dates keeps each row’s start. Undo brings them back.
                </p>
              )}
              {isDateType(draft.type) && draft.range && (
                <p className={styles.note}>Fields with an end date have no default value.</p>
              )}
              {draft.defaultValue !== null &&
                !(isDateType(draft.type) && draft.range) &&
                (draft.type === 'checkbox' ? (
                  <OptionToggleRow>
                    <OptionToggle
                      pressed={draft.defaultValue === true}
                      disabled={inputDisabled}
                      onChange={(checked) => patch({ defaultValue: checked })}
                    >
                      Checked by default
                    </OptionToggle>
                  </OptionToggleRow>
                ) : draft.type === 'datetime' ? (
                  <div className={styles.control} {...datetimeDropTarget}>
                    <label htmlFor={defaultId}>Default value</label>
                    <DateInput
                      id={defaultId}
                      className={styles.dateInput}
                      fullWidth
                      type="datetime-local"
                      step="any"
                      value={toDateTimeInput(
                        typeof draft.defaultValue === 'string' ? draft.defaultValue : null
                      )}
                      disabled={inputDisabled}
                      onChange={(value) =>
                        patch({
                          defaultValue: fromDateTimeInput(
                            value,
                            typeof draftRef.current.defaultValue === 'string'
                              ? draftRef.current.defaultValue
                              : null
                          ),
                        })
                      }
                    />
                  </div>
                ) : (
                  <TableInput
                    label="Default value"
                    onEscape={close}
                    value={String(draft.defaultValue)}
                    disabled={inputDisabled}
                    onChange={(defaultValue) => patch({ defaultValue })}
                    placeholder={
                      draft.type === 'date'
                        ? 'YYYY-MM-DD'
                        : draft.type === 'number'
                          ? 'Enter a decimal number…'
                          : 'Enter text…'
                    }
                    onSubmit={() => void autosave.flush()}
                  />
                ))}
            </>
          )}
          {isDateType(draft.type) && (
            <>
              <CalendarSection
                calendarId={shownCalendarId(draft, fieldRef.current)}
                disabled={inputDisabled}
                onChange={(calendarId) => patch({ calendarId })}
              />
              <RepeatsSection
                recurrence={shownRecurrence(draft, fieldRef.current)}
                statusFields={tableFields && statusFieldsOf(tableFields, fieldRef.current?.id)}
                disabled={inputDisabled}
                onChange={(recurrence) => patch({ recurrence })}
              />
            </>
          )}
          <TableInput
            label="Description"
            onEscape={close}
            value={draft.description ?? ''}
            multiline
            className={styles.descriptionInput}
            disabled={inputDisabled}
            onChange={(description) => patch({ description })}
            placeholder="Add context…"
            error={
              descriptionTooLong
                ? `Descriptions can contain at most ${TABLE_FIELD_DESCRIPTION_MAX_LENGTH} characters, including links.`
                : null
            }
          />
          {relation ? (
            <RelationTargetSettings
              tableId={tableId}
              draft={draft}
              resolvedTableId={normalized.referenceTableId}
              customTables={customTables}
              tablesLoading={!catalog.tables && !catalog.error}
              tablesError={catalog.error ?? null}
              onRetryTables={catalog.reload}
              disabled={inputDisabled}
              onChange={patch}
              onEscape={close}
            />
          ) : (
            draft.type === 'select' && (
              <SelectFieldSettings
                key={optionsGeneration}
                tableId={tableId}
                fieldId={fieldRef.current?.id}
                persistedOptionIds={fieldRef.current?.options?.map((option) => option.id)}
                draft={draft}
                disabled={inputDisabled}
                flushPendingRef={flushOptions}
                onChange={patch}
                onRequiredChange={(checked) => {
                  requiredChoice.current = checked;
                  patch({ nullable: !checked });
                }}
              />
            )
          )}
          {fieldRef.current &&
            draft.type !== fieldRef.current.type &&
            !(fieldRef.current.type === 'datetime' && draft.type === 'date') && (
              <p className={styles.note}>
                Existing values will be converted to the new type. If a value cannot be converted,
                the field remains unchanged.
              </p>
            )}
          {(error || (touched.current && problem && !descriptionTooLong)) && (
            <p role="alert" className={styles.error}>
              {error || problem}
            </p>
          )}
          {stale && (
            <div className={styles.note}>
              This field changed elsewhere. Load the latest settings before continuing.
              <Button size="sm" disabled={loadingLatest} onClick={() => void loadLatest()}>
                Load latest field
              </Button>
            </div>
          )}
          {dismissBlocked && (
            <div ref={dismissNoticeRef} tabIndex={-1} className={styles.dismissNotice}>
              <p className={styles.note}>Keep editing, or discard your unsaved changes.</p>
              <div className={styles.dismissActions}>
                {!problem && !stale && (
                  <Button size="sm" variant="ghost" onClick={() => void autosave.flush()}>
                    Retry save
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={autosave.saveState === 'saving' || loadingLatest}
                  onClick={() => {
                    if (!busy.current) finishClose();
                  }}
                >
                  Discard unsaved changes
                </Button>
              </div>
            </div>
          )}
        </form>
      </div>
      <div className={styles.footer}>
        <span
          className={`${styles.saveStatus} ${autosave.saveState === 'error' ? styles.error : ''}`}
          role={autosave.saveState === 'error' ? 'alert' : 'status'}
        >
          {autosave.saveState === 'dirty' && 'Waiting to save…'}
          {autosave.saveState === 'saving' && 'Saving…'}
          {autosave.saveState === 'saved' && 'Saved'}
          {autosave.saveState === 'error' && 'Not saved'}
        </span>
        <Button size="sm" variant="ghost" disabled={loadingLatest} onClick={close}>
          Close
        </Button>
      </div>
    </section>
  );
};
