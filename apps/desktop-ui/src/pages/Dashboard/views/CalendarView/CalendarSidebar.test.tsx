import { checkSidebarDisclosures } from '@desktop/test/sidebarDisclosure';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Calendar, TableCatalogEntry, TableField } from '@snaglet/shared/types';

const api = vi.hoisted(() => ({
  listCalendars: vi.fn(),
  reorderCalendars: vi.fn(),
  updateCalendar: vi.fn(),
  createCalendar: vi.fn(),
}));
vi.mock('@desktop/features/calendar/calendarApi', () => ({
  calendarApi: api,
  occurrencesSearch: () => '',
}));
const toast = vi.hoisted(() => ({ showToast: vi.fn(), dismissToast: vi.fn() }));
vi.mock('@desktop/utils/toast', () => toast);
const tables = vi.hoisted(() => ({
  fields: vi.fn(),
  setFieldCalendar: vi.fn(),
  updateField: vi.fn(),
}));
vi.mock('@desktop/utils/api', async (orig) => {
  const actual = await orig<typeof import('@desktop/utils/api')>();
  return { ...actual, tablesApi: { ...actual.tablesApi, ...tables } };
});
const catalog = vi.hoisted(() => ({ tables: [] as TableCatalogEntry[] }));
vi.mock('@desktop/features/database/useTableCatalog', () => ({
  useTableCatalog: () => ({ tables: catalog.tables, error: null, reload: vi.fn() }),
}));
vi.mock('@desktop/features/database/projectList', () => ({
  useProjectList: () => ({
    projects: [{ id: 'proj-1', name: 'Home', ancestors: [] }],
    error: null,
    reload: vi.fn(),
  }),
  projectNameOf: (projects: Array<{ id: string; name: string }> | null, id: string) =>
    projects?.find((p) => p.id === id)?.name ?? null,
}));

import { CalendarSidebar } from './CalendarSidebar';
import {
  __resetCalendarStoreForTests,
  COLLAPSED_CALENDARS_KEY,
  getCalendarsSnapshot,
  HIDDEN_CALENDARS_KEY,
} from '@desktop/features/calendar/calendarStore';
import {
  __resetCalendarViewForTests,
  updateCalendarView,
  useCalendarView,
} from '@desktop/features/calendar/calendarViewStore';
import { groupPickableFields } from '@desktop/features/calendar/FieldPicker';
import { moveId } from '@desktop/features/calendar/calendarListActions';
import { __resetCalendarUndoForTests } from '@desktop/features/calendar/calendarUndo';

function cal(extra: Partial<Calendar>): Calendar {
  return {
    id: 'cal-1',
    title: 'Default calendar',
    description: '',
    timeZone: 'UTC',
    color: null,
    isDefault: false,
    sortOrder: 0,
    revision: 1,
    createdAt: '',
    updatedAt: '',
    boundFields: [],
    ...extra,
  };
}

const field = (extra: Partial<TableField>): TableField =>
  ({
    id: 'field-1',
    name: 'Due',
    description: null,
    type: 'date',
    nullable: true,
    defaultValue: null,
    referenceTableId: null,
    revision: 7,
    ...extra,
  }) as TableField;

const table = (extra: Partial<TableCatalogEntry>): TableCatalogEntry =>
  ({ id: 't1', name: 'Tasks', origin: 'custom', projectId: null, ...extra }) as TableCatalogEntry;

describe('CalendarSidebar', () => {
  it('native sidebar disclosure expands and collapses the calendar list without opening or hiding calendars', async () => {
    __resetCalendarStoreForTests({
      calendars: [cal({ title: 'Personal' }), cal({ id: 'old', title: 'Old' })],
    });
    const open = vi.fn();
    const view = render(<CalendarSidebar onOpenCalendar={open} />);
    const hidden = getCalendarsSnapshot().hidden;
    await checkSidebarDisclosures(view.container, 'calendar');
    expect(open).not.toHaveBeenCalled();
    expect(getCalendarsSnapshot().hidden).toEqual(hidden);
    expect(api.updateCalendar).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    window.localStorage.clear();
    Object.values(api).forEach((fn) => fn.mockReset());
    Object.values(tables).forEach((fn) => fn.mockReset());
    toast.showToast.mockReset();
    api.listCalendars.mockResolvedValue({ calendars: [] });
    __resetCalendarViewForTests({ anchor: '2026-10-14' });
    __resetCalendarUndoForTests();
  });

  it('lists calendars with their bound fields (field first, then table) and undated counts', () => {
    __resetCalendarStoreForTests({
      calendars: [
        cal({
          id: 'a',
          title: 'Default calendar',
          isDefault: true,
          boundFields: [
            {
              tableId: 't1',
              tableName: 'Tasks',
              projectId: null,
              fieldId: 'f1',
              fieldName: 'Due',
              fieldType: 'date',
              repeats: false,
              unscheduledCount: 3,
            },
          ],
        }),
        cal({ id: 'b', title: 'Work', sortOrder: 1, color: 'green' }),
      ],
    });
    render(<CalendarSidebar />);
    const list = screen.getByRole('list', { name: 'Calendars' });
    expect(within(list).getByText('Default calendar')).toBeInTheDocument();
    expect(within(list).getByText('Work')).toBeInTheDocument();
    const fields = screen.getByRole('list', { name: 'Fields on Default calendar' });
    const row = within(fields).getByRole('button', { name: 'Due · Tasks, 3 undated' });
    // Field name first, the table after it (muted), the count in words.
    expect(Array.from(row.querySelectorAll('span'), (el) => el.textContent)).toEqual(
      expect.arrayContaining(['Due', 'Tasks', '3 undated'])
    );
    expect(row.textContent).toMatch(/Due.*Tasks.*3 undated/);
    expect(row).toHaveAttribute('title', 'Open Tasks · 3 rows with no Due');
    // One Add row, under the calendar with no field yet; the other has it in its ⋯ menu.
    expect(screen.getAllByRole('button', { name: '＋ Add a date field' })).toHaveLength(1);
    expect(
      within(screen.getByRole('list', { name: 'Fields on Work' })).getByRole('button', {
        name: '＋ Add a date field',
      })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More for Default calendar' }));
    expect(screen.getByRole('menuitem', { name: 'Add a date field' })).toBeInTheDocument();
    // Automatic color = a workspace theme color by sort order; explicit color wins.
    expect(screen.getByText('Default calendar').closest('[data-cal-color]')).toHaveAttribute(
      'data-cal-color',
      'theme:detail'
    );
    expect(screen.getByText('Work').closest('[data-cal-color]')).toHaveAttribute(
      'data-cal-color',
      'green'
    );
  });

  it('drag reorder: the release click is swallowed, and the next title click still opens', async () => {
    __resetCalendarStoreForTests({
      calendars: [cal({ id: 'a', title: 'Work' }), cal({ id: 'b', title: 'Home', sortOrder: 1 })],
    });
    api.reorderCalendars.mockResolvedValue({ calendars: [] });
    const onOpenCalendar = vi.fn();
    render(<CalendarSidebar onOpenCalendar={onOpenCalendar} />);
    const rows = screen
      .getAllByText(/^(Work|Home)$/)
      .map((el) => el.closest('[data-calendar-row]')!);
    rows.forEach((row, i) => {
      row.getBoundingClientRect = () =>
        ({
          top: i * 20,
          height: 20,
          bottom: i * 20 + 20,
          left: 0,
          right: 200,
          width: 200,
        }) as DOMRect;
    });
    fireEvent.pointerDown(screen.getByText('Work'), { button: 0, clientY: 5 });
    fireEvent.pointerMove(window, { clientY: 35 });
    fireEvent.pointerUp(window, { clientY: 35 });
    // The release's click lands on the list (the press and release rows differ).
    fireEvent.click(screen.getByRole('list', { name: 'Calendars' }));
    await waitFor(() => expect(api.reorderCalendars).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    fireEvent.click(screen.getByText('Home'));
    expect(onOpenCalendar).toHaveBeenCalledTimes(1);
  });

  it('drag reorder: a canceled pointer ends the drag without reordering', () => {
    __resetCalendarStoreForTests({
      calendars: [cal({ id: 'a', title: 'Work' }), cal({ id: 'b', title: 'Home', sortOrder: 1 })],
    });
    render(<CalendarSidebar />);
    const row = screen.getByText('Work').closest('[data-calendar-row]')!;
    fireEvent.pointerDown(screen.getByText('Work'), { button: 0, clientY: 5 });
    fireEvent.pointerMove(window, { clientY: 35 });
    expect(row.className).toMatch(/dragging/);
    fireEvent.pointerCancel(window);
    expect(screen.getByText('Work').closest('[data-calendar-row]')!.className).not.toMatch(
      /dragging/
    );
    fireEvent.pointerMove(window, { clientY: 60 });
    fireEvent.pointerUp(window, { clientY: 60 });
    expect(api.reorderCalendars).not.toHaveBeenCalled();
  });

  it('the eye toggle hides a calendar per viewer in localStorage', () => {
    __resetCalendarStoreForTests({ calendars: [cal({ id: 'a', title: 'Work' })] });
    render(<CalendarSidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide Work' }));
    expect(JSON.parse(window.localStorage.getItem(HIDDEN_CALENDARS_KEY)!)).toEqual(['a']);
    fireEvent.click(screen.getByRole('button', { name: 'Show Work' }));
    expect(JSON.parse(window.localStorage.getItem(HIDDEN_CALENDARS_KEY)!)).toEqual([]);
  });

  it('Color in the ⋯ menu opens the color popover: a theme pick saves the token; custom colors paint inline', async () => {
    const work = cal({ id: 'w', title: 'Work', color: '#3a7bd5' });
    __resetCalendarStoreForTests({ calendars: [work] });
    const row = () => screen.getByText('Work').closest<HTMLElement>('[data-cal-color]');
    render(<CalendarSidebar />);
    expect(row()).toHaveAttribute('data-cal-color', '#3a7bd5');
    expect(row()!.style.getPropertyValue('--cal-accent')).toBe('#3a7bd5');

    api.updateCalendar.mockResolvedValue({
      calendar: { ...work, color: 'theme:text', revision: 2 },
    });
    fireEvent.click(screen.getByRole('button', { name: 'More for Work' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Color' }));
    const popover = await screen.findByRole('dialog', { name: 'Calendar color' });
    // Text has a swatch of its own in the default theme.
    fireEvent.click(within(popover).getByRole('button', { name: 'Text' }));
    await waitFor(() =>
      expect(api.updateCalendar).toHaveBeenCalledWith('w', {
        color: 'theme:text',
        expectedRevision: 1,
      })
    );
    expect(screen.queryByRole('dialog', { name: 'Calendar color' })).toBeNull();
    await waitFor(() => expect(row()).toHaveAttribute('data-cal-color', 'theme:text'));
    expect(row()!.style.getPropertyValue('--cal-accent')).toBe('var(--text)');
  });

  it('the leaf folds a calendar’s date fields away and back, in the calendar’s own color', () => {
    const field = {
      tableId: 't',
      tableName: 'Gym',
      projectId: null,
      fieldId: 'f',
      fieldName: 'Date',
      fieldType: 'date' as const,
      repeats: false,
      unscheduledCount: 0,
    };
    __resetCalendarStoreForTests({
      calendars: [cal({ id: 'w', title: 'Work', color: '#3a7bd5', boundFields: [field] })],
    });
    render(<CalendarSidebar />);
    const leaf = screen.getByRole('button', {
      name: 'Hide the date fields and automations of Work',
    });
    expect(leaf).toHaveAttribute('aria-expanded', 'true');
    expect(
      leaf.closest<HTMLElement>('[data-cal-color]')!.style.getPropertyValue('--cal-accent')
    ).toBe('#3a7bd5');
    expect(screen.getByRole('list', { name: 'Fields on Work' })).toBeInTheDocument();

    fireEvent.click(leaf);
    expect(screen.queryByRole('list', { name: 'Fields on Work' })).toBeNull();
    const folded = screen.getByRole('button', {
      name: 'Show the date fields and automations of Work',
    });
    expect(folded).toHaveAttribute('aria-expanded', 'false');
    expect(JSON.parse(window.localStorage.getItem(COLLAPSED_CALENDARS_KEY) ?? '[]')).toEqual(['w']);

    fireEvent.click(folded);
    expect(screen.getByRole('list', { name: 'Fields on Work' })).toBeInTheDocument();
  });

  it('shows an empty state without creating a calendar', () => {
    __resetCalendarStoreForTests({ calendars: [] });
    render(<CalendarSidebar />);
    expect(
      screen.getByText('No calendars yet. Add a calendar to get started.')
    ).toBeInTheDocument();
    expect(api.createCalendar).not.toHaveBeenCalled();
  });

  describe('a calendar named in the new-calendar row', () => {
    /** Open the new-calendar row, type `name`, and press `key` in it. */
    function nameNewCalendar(name: string, key: 'Enter' | 'Escape') {
      fireEvent.click(screen.getByRole('button', { name: 'New calendar' }));
      const input = within(screen.getByRole('list', { name: 'Calendars' })).getByRole('textbox');
      fireEvent.change(input, { target: { value: name } });
      fireEvent.keyDown(input, { key });
    }

    beforeEach(() => __resetCalendarStoreForTests({ calendars: [cal({ title: 'Personal' })] }));

    it('opens the Calendar pane once it is saved, as a click on its row does', async () => {
      api.createCalendar.mockResolvedValue({ calendar: cal({ id: 'cal-new', title: 'Trips' }) });
      const onOpenCalendar = vi.fn();
      render(<CalendarSidebar onOpenCalendar={onOpenCalendar} />);

      nameNewCalendar('Trips', 'Enter');

      await waitFor(() => expect(onOpenCalendar).toHaveBeenCalledTimes(1));
      expect(api.createCalendar).toHaveBeenCalledWith({ title: 'Trips' });
    });

    it('opens nothing when the row is canceled, left blank or the create fails', async () => {
      api.createCalendar.mockRejectedValue(new Error('Server unreachable'));
      const onOpenCalendar = vi.fn();
      render(<CalendarSidebar onOpenCalendar={onOpenCalendar} />);

      nameNewCalendar('Trips', 'Escape');
      nameNewCalendar('   ', 'Enter');
      expect(api.createCalendar).not.toHaveBeenCalled();

      nameNewCalendar('Trips', 'Enter');
      await waitFor(() => expect(api.createCalendar).toHaveBeenCalledTimes(1));
      await act(async () => {});
      expect(onOpenCalendar).not.toHaveBeenCalled();
    });
  });

  it('offers deletion even for the only default calendar', () => {
    __resetCalendarStoreForTests({
      calendars: [cal({ id: 'only', title: 'Only', isDefault: true })],
    });
    render(<CalendarSidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'More for Only' }));
    expect(screen.getByRole('menuitem', { name: 'Delete calendar' })).toBeEnabled();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
  });

  it('mini month: clicking a day opens it in the pane (Week marks it, Month opens Day view)', () => {
    __resetCalendarStoreForTests({ calendars: [cal({})] });
    const onOpen = vi.fn();
    let view: ReturnType<typeof useCalendarView> | null = null;
    function Probe() {
      view = useCalendarView();
      return null;
    }
    render(
      <>
        <CalendarSidebar onOpenCalendar={onOpen} />
        <Probe />
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tuesday, October 20' }));
    expect(view).toMatchObject({ anchor: '2026-10-20', zoom: 'week', focusDay: '2026-10-20' });
    expect(onOpen).toHaveBeenCalled();
    act(() => updateCalendarView({ zoom: 'month', focusDay: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Friday, October 23' }));
    expect(view).toMatchObject({ anchor: '2026-10-23', zoom: 'day' });
  });

  it('mini month: bands the pane’s range in Week and Day, not in Month or Year', () => {
    __resetCalendarStoreForTests({ calendars: [cal({})] });
    const loaded = (from: string, to: string) => ({ from, to, occurrences: [] });
    __resetCalendarViewForTests({
      anchor: '2026-10-14',
      zoom: 'week',
      loaded: loaded('2026-10-11', '2026-10-18'),
    });
    render(<CalendarSidebar />);
    const banded = () =>
      screen
        .getAllByRole('button', { name: /day, \w+ \d+$/ })
        .filter((day) => /miniInRange/.test(day.className))
        .map((day) => day.textContent);
    expect(banded()).toEqual(['11', '12', '13', '14', '15', '16', '17']);
    act(() => updateCalendarView({ zoom: 'month', loaded: loaded('2026-09-27', '2026-11-08') }));
    expect(banded()).toEqual([]);
    act(() => updateCalendarView({ zoom: 'day', loaded: loaded('2026-10-14', '2026-10-15') }));
    expect(banded()).toEqual(['14']);
    act(() => updateCalendarView({ zoom: 'year', loaded: loaded('2026-01-01', '2027-01-01') }));
    expect(banded()).toEqual([]);
  });

  it('field picker: binds an unbound date field with calendarId and offers Undo', async () => {
    __resetCalendarStoreForTests({ calendars: [cal({ id: 'w', title: 'Work' })] });
    catalog.tables = [table({})];
    tables.fields.mockResolvedValue({
      fields: [field({}), field({ id: 'field-2', name: 'Notes', type: 'text' })],
    });
    tables.setFieldCalendar.mockResolvedValue({ field: field({ calendarId: 'w' }) });
    render(<CalendarSidebar />);
    fireEvent.click(screen.getByRole('button', { name: '＋ Add a date field' }));
    const option = await screen.findByRole('option', { name: /Due/ });
    expect(screen.queryByRole('option', { name: /Notes/ })).not.toBeInTheDocument();
    fireEvent.click(option);
    await waitFor(() => expect(tables.setFieldCalendar).toHaveBeenCalled());
    expect(tables.setFieldCalendar.mock.calls[0]).toEqual([
      't1',
      'field-1',
      { calendarId: 'w', expectedRevision: 7 },
    ]);
    expect(tables.updateField).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(toast.showToast).toHaveBeenCalledWith(
        'Showing Tasks · Due on Work',
        expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) })
      )
    );
  });

  it("field picker: a table whose fields don't load says so instead of looking empty", async () => {
    __resetCalendarStoreForTests({ calendars: [cal({ id: 'w', title: 'Work' })] });
    catalog.tables = [table({}), table({ id: 't2', name: 'Chores' })];
    tables.fields.mockImplementation(async (tableId: string) => {
      if (tableId === 't2') throw new Error('offline');
      return { fields: [field({})] };
    });
    render(<CalendarSidebar />);
    fireEvent.click(screen.getByRole('button', { name: '＋ Add a date field' }));
    expect(await screen.findByRole('option', { name: /Due/ })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load the fields of 1 table");

    tables.fields.mockRejectedValue(new Error('offline'));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search date fields' }), {
      key: 'Escape',
    });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Add a date field' })).toBeNull()
    );
    fireEvent.click(screen.getByRole('button', { name: '＋ Add a date field' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't load the fields of 2 tables"
    );
    expect(screen.queryByText('Every date field is already on a calendar.')).toBeNull();
  });

  it("field picker: lists Snaglet's created_at among the date fields and binds it", async () => {
    __resetCalendarStoreForTests({ calendars: [cal({ id: 'w', title: 'Work' })] });
    catalog.tables = [table({})];
    const created = field({
      id: 'field-managed-t1-created_at',
      name: 'created_at',
      columnName: 'created_at',
      type: 'datetime',
      nullable: false,
      managed: true,
      revision: 1,
    });
    const managedId = field({ id: 'field-managed-t1-id', name: 'id', type: 'uuid', managed: true });
    tables.fields.mockResolvedValue({ fields: [managedId, created] });
    tables.setFieldCalendar.mockResolvedValue({ field: { ...created, calendarId: 'w' } });
    render(<CalendarSidebar />);
    fireEvent.click(screen.getByRole('button', { name: '＋ Add a date field' }));
    const option = await screen.findByRole('option', { name: /created_at/ });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.click(option);
    await waitFor(() =>
      expect(tables.setFieldCalendar).toHaveBeenCalledWith('t1', 'field-managed-t1-created_at', {
        calendarId: 'w',
        expectedRevision: 1,
      })
    );
    await waitFor(() =>
      expect(toast.showToast).toHaveBeenCalledWith(
        'Showing Tasks · created_at on Work',
        expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) })
      )
    );
  });

  it('a bound field has an eye that hides it from the calendar and a ⋯ menu that removes it', async () => {
    const created = field({
      id: 'field-managed-t1-created_at',
      name: 'created_at',
      type: 'datetime',
      managed: true,
      calendarId: 'w',
      revision: 2,
    });
    __resetCalendarStoreForTests({
      calendars: [
        cal({
          id: 'w',
          title: 'Work',
          boundFields: [
            {
              tableId: 't1',
              tableName: 'Tasks',
              projectId: null,
              fieldId: created.id,
              fieldName: 'created_at',
              fieldType: 'datetime',
              repeats: false,
              unscheduledCount: 0,
            },
          ],
        }),
      ],
    });
    tables.fields.mockResolvedValue({ fields: [created] });
    tables.setFieldCalendar.mockResolvedValue({
      field: { ...created, calendarId: null, revision: 3 },
    });
    render(<CalendarSidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide created_at · Tasks' }));
    expect(getCalendarsSnapshot().hiddenFields.has(created.id)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show created_at · Tasks' }));
    expect(getCalendarsSnapshot().hiddenFields.has(created.id)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'More for created_at · Tasks' }));
    const menu = await screen.findByRole('menu', { name: 'created_at · Tasks actions' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from Work' }));
    await waitFor(() =>
      expect(tables.setFieldCalendar).toHaveBeenCalledWith('t1', created.id, {
        calendarId: null,
        expectedRevision: 2,
      })
    );
  });

  it('a bound field right-click: Remove from the calendar unbinds with Undo; Open table opens it', async () => {
    const created = field({
      id: 'field-managed-t1-created_at',
      name: 'created_at',
      type: 'datetime',
      managed: true,
      calendarId: 'w',
      revision: 2,
    });
    __resetCalendarStoreForTests({
      calendars: [
        cal({
          id: 'w',
          title: 'Work',
          boundFields: [
            {
              tableId: 't1',
              tableName: 'Tasks',
              projectId: null,
              fieldId: created.id,
              fieldName: 'created_at',
              fieldType: 'datetime',
              repeats: false,
              unscheduledCount: 0,
            },
          ],
        }),
      ],
    });
    tables.fields.mockResolvedValue({ fields: [created] });
    tables.setFieldCalendar
      .mockResolvedValueOnce({ field: { ...created, calendarId: null, revision: 3 } })
      .mockResolvedValueOnce({ field: { ...created, revision: 4 } });
    const onOpenTable = vi.fn();
    render(<CalendarSidebar onOpenTable={onOpenTable} />);
    const row = screen.getByRole('button', { name: 'created_at · Tasks' });
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    let menu = await screen.findByRole('menu', { name: 'created_at · Tasks actions' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Open table' }));
    expect(onOpenTable).toHaveBeenCalledWith('t1');

    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    menu = await screen.findByRole('menu', { name: 'created_at · Tasks actions' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from Work' }));
    await waitFor(() =>
      expect(tables.setFieldCalendar).toHaveBeenCalledWith('t1', created.id, {
        calendarId: null,
        expectedRevision: 2,
      })
    );
    await waitFor(() =>
      expect(toast.showToast).toHaveBeenCalledWith(
        'Tasks · created_at no longer shows on Work',
        expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) })
      )
    );
    const undo = toast.showToast.mock.calls.find(
      ([message]) => message === 'Tasks · created_at no longer shows on Work'
    )![1] as { action: { run: () => void } };
    act(() => undo.action.run());
    await waitFor(() =>
      expect(tables.setFieldCalendar).toHaveBeenLastCalledWith('t1', created.id, {
        calendarId: 'w',
        expectedRevision: 3,
      })
    );
    expect(tables.updateField).not.toHaveBeenCalled();
  });
});

describe('calendar sidebar helpers', () => {
  it('groups unbound date fields project → table → field and filters by search', () => {
    const items = [
      {
        table: table({ id: 't1', name: 'Tasks', projectId: 'proj-1' }),
        field: field({ id: 'a', name: 'Due' }),
      },
      {
        table: table({ id: 't1', name: 'Tasks', projectId: 'proj-1' }),
        field: field({ id: 'b', name: 'Start', type: 'datetime' }),
      },
      {
        table: table({ id: 't2', name: 'Bills', projectId: null }),
        field: field({ id: 'c', name: 'Pay by' }),
      },
      {
        table: table({ id: 't2', name: 'Bills', projectId: null }),
        field: field({ id: 'd', name: 'Bound', calendarId: 'x' }),
      },
      {
        table: table({ id: 't2', name: 'Bills', projectId: null }),
        field: field({ id: 'e', name: 'Text', type: 'text' }),
      },
      {
        table: table({ id: 't2', name: 'Bills', projectId: null }),
        field: field({ id: 'f', name: 'created_at', type: 'datetime', managed: true }),
      },
    ];
    const groups = groupPickableFields(items, '', (id) => (id === 'proj-1' ? 'Home' : null));
    expect(groups.map((g) => g.projectName)).toEqual(['Workspace', 'Home']);
    // Snaglet's own created_at is a date field like any other.
    expect(groups[0]!.tables[0]!.fields.map((f) => f.name)).toEqual(['Pay by', 'created_at']);
    expect(groups[1]!.tables[0]!.fields.map((f) => f.name)).toEqual(['Due', 'Start']);
    expect(
      groupPickableFields(items, 'sta', () => 'Home')[0]!.tables[0]!.fields.map((f) => f.name)
    ).toEqual(['Start']);
  });

  it('moveId reorders ids', () => {
    expect(moveId(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
    expect(moveId(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
  });
});
