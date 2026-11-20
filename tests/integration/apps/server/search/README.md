# Search Integration Case Databases

Search integration cases exercise TypeScript source modules through Snaglet's
`DbClient` against real, disposable PostgreSQL databases.

`freshSearchCaseDatabase.test.ts` establishes the fixture contract:

1. Jest starts one private managed-PostgreSQL cluster.
2. Snaglet migrations and the required local-user seed are applied once to
   `snaglet_template`.
3. `createFreshSearchCaseDatabase()` clones that template before each case,
   points the source-level `DbClient` at the clone, and verifies the active
   database identity.
4. Case teardown closes the source pool, drops only that exact clone, and
   removes only that case's temporary Snaglet home.

The baseline is logically empty: schema, migrations, extensions, and required
system seeds exist, while workspace/search content tables contain no rows.
Each case seeds the exact workspace content it asserts against, so every suite
here is reproducible from a clean clone of the repository.
