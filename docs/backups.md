# Backups

Everything Snaglet stores is in one folder on your computer, the Snaglet home. Backups are
snapshots of its database.

## Where your data lives

- The Snaglet home is `~/.snaglet` for the app and `~/.snaglet-dev` for a source checkout.
- It holds the database, backups, images, skills, hooks, logs and downloaded models. Linked
  project folders stay where they are.
- Don't keep it in iCloud, Dropbox, Google Drive or OneDrive: syncing a running database can
  corrupt it.
- **Settings → Local storage** shows how much space each part uses and can clear the parts
  Snaglet can rebuild, such as logs and temporary files.

## Snapshots

Open **Settings → Backups**.

- **Create snapshot** saves the whole database. You can add a label first.
- **Portable export** saves it as compressed SQL you can open elsewhere.
- **Download** copies a snapshot out. **Delete** removes it.

Snaglet takes a snapshot only when you ask, plus a safety snapshot before an update changes the
database and before a restore or reset. It keeps the last 2 pre-update snapshots. Snapshots live
in the `backups` folder of the Snaglet home.

## Restore

Click **Restore** next to a snapshot. Snaglet snapshots the current database first, then
replaces it with the one you picked. If anything fails, it puts the original back. When it
finishes, quit and reopen Snaglet.

## Clean slate

**Reset to clean slate…** wipes workspace content such as docs, threads, messages and agents.

- **Keep config** keeps your account, providers, API keys, models and settings.
- **Wipe everything** removes those too.
- Snaglet backs up first unless you turn that off.
- A reset does not empty your Database tables.

## How it's built

- Snapshots, restore and reset: `apps/server/src/services/DatabaseBackupService.ts`.
- The folder layout is in [The Snaglet home](./architecture.md#the-snaglet-home), and the
  snapshot format in [Snapshots and restore](./architecture.md#snapshots-and-restore).

## Related

- [The interface](./ui.md)
- [Development environment](./dev-environment.md)
