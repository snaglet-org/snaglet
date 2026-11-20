# Tables

Tables hold your own structured data, such as tasks, reading lists or bugs. Each is a real
PostgreSQL table that agents can query too.

## Creating a table

- Choose **Table** from the Workspace **+** menu. Inside a project it belongs to that project;
  otherwise it goes in the workspace **Tables** group. Drag it to reorder or move it.
- An agent in a project's thread puts new tables in that project unless you say otherwise.
- Names are lowercase with underscores (`reading_list`); Snaglet converts them as you type.
- Every table starts with a **Name** field, plus `id` and `created_at`, which Snaglet fills in.

## Fields

Click **+** at the end of the header row to add a field. Settings save as you go.

| Type         | Holds                     | Options                                                    |
| ------------ | ------------------------- | ---------------------------------------------------------- |
| **Text**     | Any text, including chips |                                                            |
| **Number**   | A number                  |                                                            |
| **Date**     | A date                    | **Include time**, **End date**, **Show on calendar**       |
| **Checkbox** | Yes or no                 |                                                            |
| **Select**   | One of a list of options  | **Allow multiple choices**, option colors                  |
| **Relation** | A link to a row or item   | **Links to** a table or a Snaglet item, **Allow multiple** |

- A Relation links to rows of one of **Your tables**, or to docs, projects, containers, threads,
  images, agents or members **In Snaglet**.
- Text, Number, Date and Checkbox fields also have **Required** and **Default**. Any field can
  have a description.
- **End date** makes a range ("Oct 12 – 15"). Dates show in your own time zone.
- Changing a field's type keeps your values, or Snaglet refuses the change.

## Working in the grid

- Edits save on their own; **Escape** reverts. **Cmd/Ctrl+Shift+N**, the empty bottom row or a
  row's corner **+** adds a row.
- Drag a header to move a column, or its edge to resize. The eye icon hides a column.
- The toolbar searches (**Cmd/Ctrl+F**), sorts and filters.
- The copy handle in a Name cell copies a chip for the row; drag it into a doc or thread to link
  the row. **Open entry** opens the row's window.
- To duplicate rows, check them, then **Cmd/Ctrl+C** and **Cmd/Ctrl+V**.
- **Undo** and **Redo** (**Cmd/Ctrl+Z**, **Cmd/Ctrl+Shift+Z**) step through your table changes.

## Board view

Switch from **Grid** to **Board** in the header. Each option of a single-choice **Select** field
becomes a column, plus one for no value. Drag a card to change the field; **+ New** adds a row in
that column. **Group by** picks the field when there are several.

## Tasks

There is no task type. A task is a row in a table you design, typically with a status Select (To
do, Doing, Done), a due Date, a Relation to **Members** or **Agents**, and a Relation to **Docs**
for the write-up.

## Search by meaning

- Snaglet indexes rows so `entry:` search and agents find them by meaning: "cat" finds "Feline
  care guide".
- **Search by meaning** in the header turns it off or on and shows rows indexed and size on disk.
  It is on by default up to 10,000 rows. Past that, Snaglet shows the size and indexes no more
  rows until you click **Turn on anyway**.
- Fields named like secrets (password, token, API key) are skipped. This goes by name only, so
  keep secrets out of other fields.

## Repeating rows

Any date field can repeat, with its own pattern per row.

- **Set it:** in the date's picker, choose **Repeat**. The same row edits or stops it, even on an
  empty date. Pick **Every day**, **Every week on**, **Every month on**, **Every year on** or
  **Custom…**:
  - **Custom**: every N days, weeks (on chosen weekdays) or months (a day number, or "the 2nd
    Friday").
  - **Interval** (date-and-time fields): a fixed length, such as 1 hour 30 minutes.
  - **Ends**: never, on a date, or after N times. Press **Done** to save.
- **Move on:** the date shows the current occurrence. **Done** records it and moves to the next;
  **Skip** moves on without recording. A missed one stays overdue (a dot) until you do either.
- **By status:** under **Repeat options** in the field's settings, pick a Select field, its done
  value and its reset value. Setting Done, or dragging the card to Done, then moves the date on
  and resets the status.
- **Row window:** the **Repeat** section has **Done**, **Skip**, **Move…** and a **History** with
  **Undo** per entry. Moving asks **Only this one** or **All upcoming**.

## How it's built

- `table_catalog` lists tables (`origin`, `project_id`). Each custom table is a real table in the
  `user_tables` schema, each field a column. `table_fields` holds field types, options, relation
  targets, `calendar_id` and `recurrence`; APIs key values by field id.
- `table_history` keeps a 100-step undo stack per actor, written in the same transaction.
- Repeats: `table_entry_repeats` and `table_entry_occurrences`, with the engine in
  `packages/shared/utils/tableRecurrence.ts`.
- Search by meaning: `apps/server/src/services/tableSemantic/`, vectors in
  `table_entry_embeddings`.
- Code path: `apps/server/src/routes/tables.ts` → `apps/server/src/domains/tables/` →
  `packages/db/tables/table_*`. UI: `apps/desktop-ui/src/pages/Dashboard/views/TableView/`.
- Agents use the `table` tool, backed by `apps/server/src/domains/tables/tableAgent.ts`.
- More: [Architecture](./architecture.md#data-model).

## Related

- [Calendars](./calendars.md)
- [Docs](./docs.md)
- [Projects](./projects.md)
- [Search](./search.md)
- [Hooks](./hooks.md)
