# Search over a project's linked folder

Search reaches a project's files only when `snaglet.config.json` sits at the folder root with `embeddings.enabled: true`. Without that file, or with a malformed one, the folder is not indexed (it never indexes on ambiguity).

Linking a folder in the app creates this file; linking it with the `container` tool does not. So when you link a folder and the person wants its files searchable, create it with `file`:

```json
{
  "embeddings": {
    "enabled": true,
    "includePaths": ["src", "docs"],
    "ignorePaths": ["**/generated", "**/__snapshots__", "**/fixtures", "test-results", "tmp"],
    "ignoreFileTypes": ["map", "snap", "tsbuildinfo", "lcov", "csv", "pdf"]
  }
}
```

- `includePaths`, `ignorePaths` and `ignoreFileTypes` are optional, and the ignore lists only add to what Snaglet always skips: dependency and build folders (`node_modules`, `dist`, `build`, `.next`, `.turbo`, `coverage`, `.cache`), lockfiles, dotfiles and dot-folders, images, audio and video, archives, binaries, fonts, Office files, logs, local databases, and any text file over 256 KB. Don't list those again. Do ignore generated output, snapshots, fixtures, test results, scratch folders, source maps and build metadata, and large data such as CSV exports. PDFs are indexed (their text is extracted) unless you ignore `pdf`.
- Edits take effect live; `enabled: false` turns indexing off.
- Indexing makes the folder's files searchable by meaning for every agent, so turn it on only when the person asked for it or the project plainly needs it, and never in a folder with secrets or personal files.
- If `snaglet.config.json` exists, read it and edit only the `embeddings` keys. Keep every other key, including `projectId`, which Snaglet writes. `enabled: false` is a person's opt-out: leave it unless they ask.
- If you can't write in that folder, tell the person to switch on file indexing in the project's folder settings.

Read the file back to check the JSON, and say that large folders take a while to index.
