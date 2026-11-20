# Development environment

How to set up, run and check Snaglet from a source checkout: prerequisites, first
run, ports, environment and database modes, local models, resetting, and every
root script.

## Prerequisites

- macOS 14 or later on Apple Silicon.
- Node.js 22 or newer, and pnpm through Corepack (`package.json` pins it). If
  your Node.js has no `corepack` command, install it with
  `npm install -g corepack`. If `corepack enable` can't write next to your Node.js
  installation, run it with `sudo`.
- Apple's Command Line Tools (`xcode-select --install`). The first run uses
  them to compile Snaglet's PostgreSQL runtime. If that fails, the error names the
  saved `config.log`; updating the Command Line Tools usually fixes it.
- An internet connection for the first run, which downloads the PostgreSQL and
  pgvector source.
- Desktop shell only (`pnpm dev:desktop`, `pnpm build:desktop`,
  `pnpm install:app`): Rust from [rustup](https://rustup.rs).
  `apps/desktop/src-tauri/rust-toolchain.toml`
  pins the version. If `cargo` is not on your `PATH`, run
  `source ~/.cargo/env`. The desktop scripts run the Tauri CLI with that
  version through `RUSTUP_TOOLCHAIN`, so no rustup default is needed, and they
  stop with the `rustup toolchain install` command to run when it is missing.
- Apple's on-device dictation: it runs on macOS 26 or later, and its helper
  (`apps/server/native/apple-stt`) builds only with the macOS 26 SDK, from
  Xcode 26 or its Command Line Tools (they need macOS 15.6 or later). With an
  older SDK, `pnpm build:desktop` still succeeds: it logs that it skipped the
  helper and records that in `native/helpers.json`, and that app dictates with
  Snaglet's own voice models on every macOS. On macOS 14 and 15, Snaglet always uses
  them. Snaglet offers to download them the first time you dictate.
- Memory for `pnpm build:desktop`: 8 GB is enough. The desktop UI build sets
  Node's heap limit to 4 GB itself, and its heap peaks near 2 GB (3 GB for
  profiles that keep source maps). A `--max-old-space-size` in your
  `NODE_OPTIONS` overrides the limit.
- Windows x64 (still in progress): see
  [Windows development](./windows-development.md).
- Linux: not supported yet, still in progress; see
  [Linux development](./linux-development.md).

You do not install PostgreSQL. Snaglet builds and runs its own pinned runtime
(PostgreSQL 17 with pgvector), without Homebrew, Postgres.app or Docker.

## Initial setup

```bash
corepack enable
pnpm install
pnpm dev
```

`pnpm dev` starts the shared and db package watchers, the server and the Vite
UI. The first run:

1. Runs `pnpm dev:setup`, which copies `.env.example` to `.env` and fills in a
   generated `CREDENTIAL_ENCRYPTION_KEY`.
2. Downloads checksum-pinned PostgreSQL and pgvector source and compiles them
   into `~/.snaglet-dev/cache/postgres-runtime`. Later starts reuse the build.
3. Creates the cluster under `~/.snaglet-dev/postgres` and the `snaglet` database with the
   full schema. Snaglet then adds the two starter agents, Patty and Clio, and seeds the
   starter content once (`apps/server/src/services/onboarding/`).

Then open <http://localhost:3001>.

`pnpm dev`, `pnpm dev:server` and `pnpm dev:desktop` all run `pnpm dev:setup`
first. It never replaces a key, and it makes none when a database already
exists. Keep your `.env`: without the key, saved provider credentials cannot be
read. To set the key by hand, paste the output of this command into
`CREDENTIAL_ENCRYPTION_KEY`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

In development, provider keys in your environment or `.env.local` / `.env`
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and the others in `.env.example`) are
saved at startup as encrypted `Test credential` rows. Production startup never
imports them. See [Providers](./providers.md).

### The desktop window

`pnpm dev:desktop` opens the Tauri window and starts its own Vite UI on
`CLIENT_PORT`, but it starts no server. Run `pnpm dev:server` in one terminal
and `pnpm dev:desktop` in another. Don't combine it with `pnpm dev`, which also
starts a Vite UI on the same port.

## Ports

| Service           | `pnpm dev` | `pnpm preview` |
| ----------------- | ---------- | -------------- |
| Server API        | `4001`     | `4101`         |
| Desktop UI / Vite | `3001`     | `3101`         |

Set `PORT` and `CLIENT_PORT` in `.env.local` to change them. A busy port stops
startup with an error; Snaglet does not pick another port. The server listens on
`127.0.0.1` unless you set `SNAGLET_BIND_HOST`.

## Environment modes (`SNAGLET_ENV`)

The launch scripts set `SNAGLET_ENV`, so development data stays apart from a real
install in `~/.snaglet`. Never point a development server at `~/.snaglet`.

| Command                                | `SNAGLET_ENV` | Snaglet home     | Database          |
| -------------------------------------- | ------------- | ---------------- | ----------------- |
| `pnpm dev`, `pnpm dev:desktop`         | `dev`         | `~/.snaglet-dev` | `snaglet`         |
| `pnpm preview`, `pnpm preview:desktop` | `preview`     | `~/.snaglet-dev` | `snaglet_preview` |
| Packaged app, `pnpm install:app`       | unset         | `~/.snaglet`     | `snaglet`         |
| `pnpm simulate:first-run`              | unset         | throwaway        | `snaglet`         |

`pnpm simulate:first-run` only simulates a first launch in a throwaway home; it
installs nothing. `pnpm install:app` builds the app and installs it.

Settings are read from, highest first: the shell, `.env.local`, `.env.dev` or
`.env.preview`, `.env`, then the mode default (`packages/db/runtime/snaglet-env.ts`).
Dev and preview share one cluster, and quitting the preview desktop app stops
it, so restart a running dev server afterward.

### Database scripts need a target

`db:init`, `db:migrate`, `db:scratch` and `sync:tool` print their target and
refuse to write until you name one: `SNAGLET_ENV`, `SNAGLET_HOME` or `SNAGLET_DATABASE_URL` in
the shell or env files, or `--target=dev|preview|prod|external`. An external
URL also needs `--target=external`. The live home `~/.snaglet` also needs
`--target=prod` and `SNAGLET_ALLOW_PROD_WRITE=1` exported in the shell. `--dry-run`
prints the target and pending migrations and writes nothing.

```bash
SNAGLET_ENV=dev pnpm db:migrate --dry-run
SNAGLET_ENV=dev pnpm db:migrate
```

## Database

Snaglet has two PostgreSQL modes (`packages/db/db.ts`):

- **Managed** (default): Snaglet runs its own cluster under `<SNAGLET_HOME>/postgres` and
  creates the `snaglet` database in it.
- **External**: set `SNAGLET_DATABASE_URL` and Snaglet connects to that database only,
  never starting or stopping its server. It needs PostgreSQL 17 and pgvector
  0.8.5.

A fresh database gets the full schema at boot. After that, only the packaged
app applies new migrations at boot, after a backup. A source checkout warns
(`/health/ready` reports a schema error) until you run `pnpm db:migrate`, which
also syncs built-in tool metadata.

Other settings: `SNAGLET_HOME` (the Snaglet home; `~/.snaglet`, or `~/.snaglet-dev` under
`pnpm dev`), `SNAGLET_DATABASE_NAME` (default `snaglet`), `SNAGLET_PG_DATA_DIR` (default
`<SNAGLET_HOME>/postgres`) and `SNAGLET_PG_RUNTIME_DIR` (default
`<SNAGLET_HOME>/cache/postgres-runtime`). In managed mode Snaglet creates the roles its
agent SQL tools use. With `SNAGLET_DATABASE_URL` those tools stay off until you
create the roles and set the `SNAGLET_*_READER_URL` and `SNAGLET_WORKSPACE_WRITER_URL`
values listed in `.env.example`.

## Local models

Semantic search uses a local ONNX embedder (`nomic-embed-text-v1.5`, about
137 MB). It is not in the repo. In development, background model work is off
unless you set `SNAGLET_LOCAL_INTELLIGENCE=true`; with it on, the server downloads
the embedder when it is missing and embeds content in the background. The
packaged app turns it on. `pnpm embedder:fetch` downloads the model from a
pinned, checksum-verified source into `<SNAGLET_HOME>/models/`, and `pnpm db:init`
runs it. A failed download warns and exits 0 unless you pass `--strict`;
`--force` downloads again. Without the files Snaglet keeps running, and search skips
embeddings.

A local reranker (`ms-marco-MiniLM-L6-v2`) can re-sort agent search results.
It is off by default, and Snaglet never downloads or loads its model while it is
off. [Turning on the reranker](#turning-on-the-reranker) explains how.

## Logs

The server log (`<SNAGLET_HOME>/logs/server.log`) records what ran, not what was
said: one line per model call with counts, one line per tool call with the
tool, status and duration (and a short reason when it fails), and message
events without their text. To debug prompt assembly or a tool, set
`SNAGLET_LOG_CONTENT=1`: the log then includes message and reply previews,
thinking, tool inputs and outputs, and each model call's system blocks and
messages. That is conversation content, so leave it off otherwise.

The log keeps entries at `LOG_LEVEL` and above. The `.env` that `pnpm dev`
creates sets `LOG_LEVEL=error`, so a source checkout's log holds only errors;
set `LOG_LEVEL=info` in `.env.local` to record the lines above. The packaged app
logs at `info`.

## Reset your development data

To clear workspace content but keep the database and your providers, use
**Settings → Backups → Reset to clean slate…** in the app.

To start over completely, stop every dev and preview server, then delete
`~/.snaglet-dev` and the checkout's `.env` together. `~/.snaglet-dev` holds the dev and
preview databases, snapshots, images, hooks, skills, downloaded models and the
compiled PostgreSQL runtime. Deleting only `.env` leaves a cluster whose
credentials need the old key, so `pnpm dev:setup` refuses to make a new one.
The next `pnpm dev` creates a new key and compiles PostgreSQL again.

## Common scripts

Every script in the root `package.json`:

```bash
# Run
pnpm dev                    # shared + db + server + desktop UI in dev mode
pnpm dev:server             # server only
pnpm dev:desktop-ui         # desktop UI (Vite) only
pnpm dev:desktop            # native Tauri shell
pnpm dev:setup              # create .env and the credential key
pnpm preview                # build and serve the browser preview in preview mode
pnpm preview:desktop        # build and launch the desktop preview in preview mode
pnpm preview:scratch        # built browser preview on a fresh throwaway database
pnpm simulate:first-run        # simulate a first launch in a throwaway home (installs nothing)
pnpm install:app            # build the desktop app, install it in /Applications, open it
# Build
pnpm build                  # workspace packages: shared, db, sdk, server
pnpm build:web              # desktop UI bundle
pnpm build:server           # server bundle
pnpm build:browser-preview  # browser preview (web + server)
pnpm build:desktop-preview  # packaged desktop preview app
pnpm build:desktop          # packaged desktop app
pnpm stage:desktop          # stage the desktop sidecar without packaging
pnpm clean                  # remove build output
# Database and PostgreSQL runtime
pnpm db:init                # create the database, then fetch the embedder (--with-reranker adds the reranker)
pnpm db:migrate             # apply migrations, then sync built-in tools
pnpm db:scratch <name>      # scratch database on the managed cluster
pnpm pg:runtime:build       # build the pinned runtime (--strict, --force)
pnpm pg:runtime:verify      # managed runtime lifecycle check
pnpm pg:backup:verify-recovery  # backup, restore and recovery check
pnpm sync:tool --all        # sync built-in tool metadata (or pass one tool id)
# Local models and macOS helpers
pnpm embedder:fetch         # download the embedder model
pnpm reranker:fetch         # download the reranker model (off by default, see Local models)
pnpm nlp:build              # entity-extraction helper
# Tools and CLI
pnpm tool                   # list, inspect or run a built-in tool
pnpm snaglet                # the snaglet command line (run sandbox scripts)
# Check while working
pnpm verify:changed         # typecheck touched packages, run related tests
pnpm typecheck              # shared, db, sdk, server
pnpm typecheck:all          # everything, including UI and build scripts
pnpm lint                   # lint:eslint + lint:realtime + lint:docs
pnpm lint:eslint            # ESLint
pnpm lint:realtime          # realtime import boundaries
pnpm lint:docs              # documentation gate
pnpm lint:baseline          # ESLint + Knip against quality-baseline.json
pnpm format:check           # Prettier
# Test
pnpm test                   # every Jest project
pnpm test:unit              # server + shared unit tests, no database
pnpm test:integration       # integration tests, one database per test file
pnpm test:coverage          # unit tests with coverage
pnpm test:ui                # @snaglet/ui component tests
pnpm test:desktop-ui        # desktop UI tests
pnpm test:e2e               # fresh-install server gate
pnpm test:e2e:ui            # Playwright against the running dev UI
pnpm test:e2e:built         # Playwright against a built preview on a temp database
pnpm test:e2e:app           # packaged macOS app: launch, health, upgrade
pnpm test:package-exports   # compiled package entry points
pnpm test:tool-registry     # strict tool registry audit
pnpm test:build-profiles    # build, packaging and docs-gate contracts
pnpm test:desktop-stage     # desktop staging is complete and repeatable
# Full gates
pnpm verify                 # build, typecheck:all, exports, tool registry, all tests
pnpm verify:artifacts --profile <name>  # check a built artifact
pnpm prepare                # install the git pre-commit hook (runs on install)
```

`pnpm verify:changed` is the everyday check; after `--` it takes file paths,
`--since <ref>` or `--integration`. Run the full suites before a push.

## Advanced setups

### Running two checkouts at once

A second checkout, such as a git worktree, can share the first one's Snaglet home
and PostgreSQL cluster instead of starting another PostgreSQL server. In its
`.env.local`, set `SNAGLET_HOME=~/.snaglet-dev`, the same `CREDENTIAL_ENCRYPTION_KEY`, its
own `PORT` and `CLIENT_PORT`, `RUN_BACKGROUND_WORKERS=false`, and an
`SNAGLET_DATABASE_URL` for the shared cluster so this server never starts, stops or
migrates it. Reload the other UI to see its changes. To try schema changes
without touching the shared database, create a scratch database on the cluster:

```bash
SNAGLET_HOME=~/.snaglet-dev pnpm db:scratch my-branch
```

It prints the `SNAGLET_DATABASE_URL` to use. That URL holds the cluster password, so
keep it in `.env.local`.

### Turning on the reranker

While the reranker is off, search keeps the hybrid order,
`POST /api/rerank` answers 409, and `GET /api/rerank/status` reports
`enabled: false`. To turn it on, enable its feature flag in your dev database:

```sql
INSERT INTO public.feature_flags (id, name, enabled) VALUES ('feature-flag-reranker', 'reranker', true) ON CONFLICT (name) DO UPDATE SET enabled = true;
```

The server rereads the flag within 30 seconds. Then fetch the model with
`pnpm reranker:fetch` (or `pnpm db:init --with-reranker`). The packaged app,
and a dev server with `SNAGLET_LOCAL_INTELLIGENCE=true`, download it themselves at
the next start or the next search.
