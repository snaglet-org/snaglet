/**
 * The reopen-after-close guard on `getDbClient()` (packages/db/db.ts), which
 * stops a late afterAll from silently reopening a closed pool.
 *
 * Lives under tests/unit/apps/server because the unit:server project maps `pg`
 * to `tests/support/postgresPoolStub.cjs` and selects external mode with a
 * fake URL, so the real singleton logic runs without a socket or a managed
 * PostgreSQL process. `beforeEach` reopens through the explicit escape hatch
 * (`{ allowReopenAfterClose: true }`) so every test starts from a known-open
 * baseline; that is test scaffolding, not the case the guard defends against.
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { closeDatabase, getDbClient, resolveDatabaseMode } from '@snaglet/db/db';

describe('resolveDatabaseMode()', () => {
  it('selects url mode from SNAGLET_DATABASE_URL and defaults to managed otherwise', () => {
    expect(resolveDatabaseMode({})).toBe('managed');
    expect(resolveDatabaseMode({ SNAGLET_DATABASE_URL: 'postgresql://u:p@h:5432/db' })).toBe('url');
    // A blank/whitespace override is ignored rather than selecting url mode.
    expect(resolveDatabaseMode({ SNAGLET_DATABASE_URL: '   ' })).toBe('managed');
    // SNAGLET_DB_MODE does not influence the mode; an explicit `managed` is a no-op
    // rather than an error because it agrees with the result.
    expect(resolveDatabaseMode({ SNAGLET_DB_MODE: 'managed' })).toBe('managed');
  });

  it('throws on a retired SNAGLET_DB_MODE value that would otherwise be silently ignored', () => {
    // Resolving `managed` here would connect to the SNAGLET_HOME cluster and write
    // to the live database the operator set `external` to stay away from.
    expect(() => resolveDatabaseMode({ SNAGLET_DB_MODE: 'external' })).toThrow(
      /SNAGLET_DB_MODE is retired/
    );
  });

  it('ignores a retired SNAGLET_DB_MODE once SNAGLET_DATABASE_URL supplies the override', () => {
    expect(
      resolveDatabaseMode({
        SNAGLET_DB_MODE: 'external',
        SNAGLET_DATABASE_URL: 'postgresql://u:p@h:5432/db',
      })
    ).toBe('url');
  });
});

describe('getDbClient() reopen-after-close guard (packages/db/db.ts)', () => {
  beforeEach(async () => {
    await getDbClient({ allowReopenAfterClose: true });
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it('returns the same cached client on repeat calls while open', async () => {
    const a = await getDbClient();
    const b = await getDbClient();
    expect(a).toBe(b);
  });

  it('throws a clear, actionable error when called after closeDatabase() with no explicit reopen', async () => {
    await closeDatabase();
    await expect(getDbClient()).rejects.toThrow(
      /getDbClient\(\) called after closeDatabase\(\) already ran/
    );
    // The case the guard exists for: a mis-ordered file-top-level
    // `afterAll(cleanup)` querying the DB after the shared teardown closed it.
    // It must throw a readable error rather than silently boot a fresh,
    // never-closed instance.
    await expect(getDbClient()).rejects.toThrow(/nest the DB-touching `afterAll`/);
  });

  it('does not silently self-heal on retry — stays armed until an explicit reopen', async () => {
    await closeDatabase();
    await expect(getDbClient()).rejects.toThrow();
    // A second unflagged attempt still throws — nothing was leaked/opened by
    // the first failed call.
    await expect(getDbClient()).rejects.toThrow();
  });

  it('allows an explicit, acknowledged reopen after close, and the guard re-arms on the next close', async () => {
    await closeDatabase();
    await expect(getDbClient()).rejects.toThrow();

    // The legitimate "close, re-point config, reopen" flow (mirrors
    // migrationRestoreRecovery.test.ts's corrupt-artifact case): an explicit
    // opt-in reopens successfully instead of throwing.
    const reopened = await getDbClient({ allowReopenAfterClose: true });
    expect(reopened).toBeTruthy();

    // Guard is cleared by the successful reopen — an unflagged call while
    // still open just returns the cached client, no throw.
    await expect(getDbClient()).resolves.toBe(reopened);

    // Closing again re-arms the guard — it doesn't stay permanently disabled
    // after the first acknowledged reopen.
    await closeDatabase();
    await expect(getDbClient()).rejects.toThrow(
      /getDbClient\(\) called after closeDatabase\(\) already ran/
    );
  });
});
