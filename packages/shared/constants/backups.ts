/**
 * How many automatic pre-update database snapshots Snaglet keeps, counting the one
 * the latest update just took. Each is a full dump of the database, so older
 * ones are deleted once an update's migrations succeed. Applies to both
 * copies an update makes: the pre-migration snapshots on Settings → Backups
 * (`<SNAGLET_HOME>/backups/*.dump`) and the packaged app's checkpoints in
 * `<SNAGLET_HOME>/backups/pre-migration/`. Snapshots the user makes are never
 * pruned.
 */
export const PRE_UPDATE_SNAPSHOT_RETENTION = 2;
