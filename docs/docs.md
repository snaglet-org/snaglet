# Docs

Docs are Markdown pages with a rich editor and autosave. You and your agents edit the same docs.

## Writing

- Markdown formats as you type. At a line's start: `#` to `######` and a space (headings), `-`,
  `*` or `+` (bullets), `1.` (numbers), `[ ]` (task), `>` (quote), ` ``` ` and Enter (code),
  `---` (divider). Inline: `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``,
  `[text](https://…)`. **Backspace** or **Cmd/Ctrl+Z** right after undoes the formatting.
- `/` opens block commands. Right-click opens the format menu; pick a checked item to remove it.
- **Shift+Enter** adds a line inside the paragraph. **Backspace** at the start of a heading, list
  item or quote makes it plain text.
- **Cmd/Ctrl+F** finds and replaces.
- The **md / txt** toggle shows the raw Markdown and keeps your cursor and place.
- `/` then **Table** inserts a table. Inside it, `/` adds or deletes rows and columns, and the
  corner **×** deletes it. A new line in a cell is `<br>` in the Markdown.
- A code block tagged `mermaid` renders as a diagram. Images open in a pane with zoom and pan.

| Shortcut                             | Format                  |
| ------------------------------------ | ----------------------- |
| **Cmd/Ctrl+Alt+0**                   | Text                    |
| **Cmd/Ctrl+Alt+1** to **3**          | Heading 1 to 3          |
| **Cmd/Ctrl+Shift+8** / **7** / **9** | Bullets, numbers, tasks |
| **Cmd/Ctrl+Shift+B**                 | Quote                   |
| **Cmd/Ctrl+Alt+C**                   | Code block              |
| **Cmd/Ctrl+B** / **I** / **E**       | Bold, italic, code      |
| **Cmd/Ctrl+Shift+S**                 | Strikethrough           |

## Links and chips

- `@` inserts a chip for a doc, thread, table, table row, agent or file. So does dragging items
  from the Workspace tree; select several rows first for one chip each. Dropping on a pane's edge
  opens the item instead.
- Click a chip to preview it. A message chip opens its thread at that message.
- Select text, or hover a heading, to copy a link to that part.
- Link a heading in the same doc as `[Next steps](#h=next-steps)`: lowercase words joined by `-`,
  punctuation dropped. GitHub's `#next-steps` works too.
- Right-click a web link and pick **Open link** to open it in your browser; **Link…** in the same
  menu changes its address. A plain click places the caret, so you can edit the link's text.
- **Cmd-click** (**Ctrl-click** on Windows) opens a web link too, or follows a heading link in raw
  Markdown.

## Transclusions

A transclusion shows another doc's content inside this one, kept in sync.

- Click **Transclude** on a doc chip. **Show as link** turns it back.
- In Markdown it is `![title](doc-id)`, or `![title](doc-id#h=setup)` for one heading or lines.
- The content belongs to the source doc, so edit it there. An agent's edit inside a transclusion
  goes to the source doc too.
- A doc can't transclude itself, directly or through a chain. Snaglet names the loop and saves
  nothing. A loop already stored shows a notice instead.

## Outline and versions

- **Outline**, in the doc's **Properties**, lists its headings. Click one to jump to it.
- **Snapshot**, also in **Properties**, saves a version. **Versions** previews, restores or
  deletes one, or clears them all. A restore saves the current text as a version first.
- Snapshot before letting an agent rewrite a doc.

## How it's built

- A doc is a `doc` node with its Markdown in `docs` and versions in `doc_snapshots`
  (`packages/db/tables/docs/DocModel.ts`, `apps/server/src/domains/docs/docs.routes.ts`).
- The editor is TipTap with a `prosemirror-markdown` round trip, in
  `apps/desktop-ui/src/features/rich-markdown/`. The pane is
  `apps/desktop-ui/src/pages/Dashboard/views/DocView/`.
- Chips are Markdown links to node ids. Saving syncs them into `references` rows in `links`
  (`apps/server/src/services/contentRefs.ts`).
- Every doc write runs `packages/db/tables/docs/transclusionLoop.ts`.
  `apps/server/src/services/transclusions/` expands transclusions for readers and routes edits.
- Agents use the `doc` tool (`apps/server/src/services/ToolService/tools/docs/doc/`).
- More: [Architecture](./architecture.md#data-model).

## Related

- [Projects](./projects.md)
- [Tables](./tables.md)
- [Search](./search.md)
- [Threads](./threads.md)
- [The interface](./ui.md)
