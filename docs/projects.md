# Projects

A project groups threads, tables, docs and containers, and can link a folder on your computer. A
container is a plain folder in the Workspace tree.

## Using it

- Create either from the Workspace **+** menu.
- To turn a container into a project, open its **Properties** and choose **Make this a project**.
  It can't be undone, and agents can't do it.
- Threads and tables belong to a project or to none, never to a plain container.

## Linked folders

- Set the folder in the project's **Properties**. Snaglet shows how many files it will index,
  then indexes them for search and agents. They list under **Files**, with read-only previews of
  text, Markdown, PDFs and common audio.
- Linking adds a `snaglet.config.json` to the folder if it has none. Edit it by hand or with
  **Indexing paths and rules**:

```json
{
  "embeddings": {
    "enabled": true,
    "ignorePaths": ["dist", "notes/drafts.md"],
    "ignoreFileTypes": ["csv"]
  }
}
```

- `includePaths` is an optional allowlist. `node_modules`, `.git`, build output, lockfiles,
  binaries, media and dotfiles are always skipped.
- **Disable background indexing** sets `"enabled": false`: indexing pauses, the index stays.
- Unlinking, or deleting `snaglet.config.json`, deletes the index. Your files are never changed.
- A moved folder is relinked when Snaglet finds exactly one match under your home folder or
  places such as `Projects`, `Desktop` and `Documents`. Otherwise Snaglet pauses indexing and
  notifies you; set the new path in **Properties**. A missing folder never deletes the index.

## Renaming images

- Double-click an image's name in the Workspace tree or pane title, press **F2**, or right-click
  and choose **Rename**. Agents can too. The stored file becomes `<name>-<image id>.png` (or
  `.jpg` and so on) in `~/.snaglet/images`, so two images can share a name.
- An image in a linked folder is renamed on disk, from its pane title. It keeps its type
  (`Sunset` and `Sunset.png` both work; `.jpg` and `.jpeg` match). A name already in the folder is
  refused; changing only capitals works.
- File chips hold the path, so chips made before a rename stop opening the file.

## How it's built

- A project is a `containers` row with `category = 'project'`; there is no projects table.
  `folder_path` and the other project columns are read through
  `packages/db/tables/projects/ProjectModel.ts`. A trigger stops a project turning back into a
  container.
- Routes: `apps/server/src/domains/containers/` (`ContainerTreeService.ts` builds the tree) and
  `apps/server/src/domains/projects/projects.routes.ts`.
- `apps/server/src/services/fileIndexing/` watches linked folders, applies the config and fills
  `files` and `file_embeddings`. `projectFolderRecovery.ts` in `apps/server/src/services/`
  relinks moved folders.
- Renames: `apps/server/src/domains/files/renameProjectFile.ts` and `ImageModel.rename`
  (`packages/db/tables/images/ImageModel.ts`).
- UI: `apps/desktop-ui/src/pages/Dashboard/views/ContainerView/` and
  `apps/desktop-ui/src/features/workspace-tree/`. Agents use the `container` tool.
- More: [Architecture](./architecture.md#data-model).

## Related

- [Docs](./docs.md)
- [Tables](./tables.md)
- [Threads](./threads.md)
- [Search](./search.md)
- [Backups](./backups.md)
