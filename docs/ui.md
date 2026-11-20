# The interface

How the Snaglet window is laid out and how to move around it.

## Layout

- **Activity bar** (far left): switches the sidebar between **Workspace**, **Calendar**,
  **Agents**, **Providers**, **Tools**, **Skills**, **Automations**, **MCP** and **Settings**.
- **Workspace tree**: projects first, then the workspace-wide groups **Docs & context**,
  **Threads** and **Tables**. A project shows only what it holds: **Files** (once it links a
  folder), **Threads**, **Tables**, then its containers and docs.
- **+**: creates a project, container, doc, thread or table.
- **Status bar** (bottom): the connection, running agents, scripts and automations,
  notifications and background **Workers**.

## Panes

Drag an item from the sidebar, or a chip from a message or doc, onto the edge of a pane to open
it side by side. Drop it in the middle to replace that pane.

Each pane keeps its own history. The arrows at its top left step back and forward, and the third
button opens **Recently visited**.

The keys below act on the focused pane, the one you last clicked or moved to. On Windows and
Linux, use Ctrl for Cmd and Alt for Option.

| Shortcut                          | What it does                                                   |
| --------------------------------- | -------------------------------------------------------------- |
| **Cmd+[** / **Cmd+]**             | Back / forward, also while you type                            |
| **Cmd+Y**                         | Open Recently visited (not while typing: there Cmd+Y is redo)  |
| **Cmd+Up**                        | Open the folder or project holding the item (not while typing) |
| **Cmd+Option+Left/Right/Up/Down** | Move to the pane on that side                                  |
| **Ctrl+Tab** / **Ctrl+Shift+Tab** | Move to the next / previous pane                               |

In Recently visited:

- **Up**, **Down**, **Home** and **End** move.
- **Enter** opens the place in this pane. **Cmd+Enter** or Cmd-click opens it in a new pane.
- **1** to **9** open that row. Typing a name jumps to it.
- **Esc** closes the menu.

## Undo

Most actions happen at once and show a toast with **Undo**. Permanent actions still ask first:
deleting from the Archived drawer, deleting a calendar, and restoring a backup.

## Archive and delete

- **Archive**: right-click an item and choose **Archive**, or drag it onto the trash icon in the
  sidebar. Tables, table columns and automations can be dragged there too.
- **Archived drawer**: click the trash icon. **Restore** an item or **Delete** it for good. Each
  item says where it came from, for example "in Website › drafts".
- **Search the drawer**: every word must match an item name. Add a folder or project name to
  narrow it: `website notes` finds items named "notes" inside a "Website" project. The chips
  narrow the list to one kind and show a count for each.
- **Escape** clears the search. Press it again to close the drawer.

How long archived items stay:

| Item                                  | Kept                           |
| ------------------------------------- | ------------------------------ |
| Docs, threads and containers          | Deleted for good after 30 days |
| Tables, table columns and automations | Until you delete them          |

## Theme

The default theme has near-black panels, off-white text and pastel accents. It is a dark theme
whatever your system setting.

**Settings → Theme** lists every color with what it paints.

- Change a color with its swatch or hex box.
- ↺ puts one color back. **Reset to Soft Pastel Garden** puts them all back.
- Colors are saved for the whole workspace. An agent can change them with the
  `change_color_theme` tool.

## How it's built

- Pane layout and history: `apps/desktop-ui/src/pages/Dashboard/layout`.
- Sidebar and tree: `apps/desktop-ui/src/pages/Dashboard/sidebar` and
  `apps/desktop-ui/src/features/workspace-tree`.
- Status bar: `apps/desktop-ui/src/components/StatusBar`.
- Archive: `apps/server/src/services/ArchiveService.ts`. The 30-day cleanup is
  `apps/server/src/services/ArchiveTtlSweeper.ts`.
- Theme colors: `packages/shared/constants/workspaceTheme.ts`. See
  [The color theme](./architecture.md#the-color-theme).

## Related

- [Search](./search.md)
- [Projects](./projects.md)
- [Backups](./backups.md)
