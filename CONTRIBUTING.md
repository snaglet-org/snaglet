# Contributing to Snaglet

Thanks for helping improve Snaglet. This page covers setup, where code lives, how to
check a change, and the rules for docs, commits and pull requests.

## Set up

You need macOS 14 or later on Apple Silicon, Node.js 22 or newer, pnpm through
Corepack, and Apple's Command Line Tools (`xcode-select --install`). On Windows,
start with [Windows development](docs/windows-development.md).

Clone the repository, then:

```bash
corepack enable
pnpm install
pnpm dev
```

The first `pnpm dev` creates `.env` with a credential key, then downloads and
compiles Snaglet's PostgreSQL runtime once. Open <http://localhost:3001>. Your
development data lives in `~/.snaglet-dev`. Everything else about setup is in
[Development environment](docs/dev-environment.md).

## Repository layout

```text
apps/
  desktop/          Tauri desktop shell (Rust)
  desktop-ui/       React + Vite UI
  server/           Express + WebSocket server and the agent runtime
packages/
  db/               SQL models, migrations and the PostgreSQL runtime
  shared/           Shared types, constants and utilities
  snaglet-sdk/      SDK that hooks and custom tools import
  snaglet-cli/      The `snaglet` command line
  ui/               Shared React components
tests/              Unit, integration, end-to-end and build tests
build/              Desktop packaging
scripts/            Dev setup, lint gates and database scripts
```

## Where changes land

| You want to change...     | Look in                                                         |
| ------------------------- | --------------------------------------------------------------- |
| UI views and components   | `apps/desktop-ui/src/pages/`, `apps/desktop-ui/src/components/` |
| API routes                | `apps/server/src/domains/`, `apps/server/src/routes/`           |
| Agent chat and dispatch   | `apps/server/src/services/SocketService/`                       |
| Built-in agent tools      | `apps/server/src/services/ToolService/tools/`                   |
| SQL models and migrations | `packages/db/`                                                  |

Apps may import packages. Packages do not import app code.
[Architecture](docs/architecture.md) explains how the pieces fit.

## Check your change

Run these locally before you open a pull request:

```bash
pnpm verify:changed   # checks related to the files you changed
pnpm test:unit        # fast, no database
pnpm typecheck        # shared, db, sdk and server
pnpm lint             # ESLint, realtime boundaries and the docs gate
pnpm format:check     # Prettier
```

Run `pnpm test:integration` when you touch database code. Run
`pnpm typecheck:all` when you touch shared types, the UI or package boundaries.

- To run part of a suite, pass a path or a name pattern:
  `pnpm test:unit tests/unit/packages/shared`.
- `pnpm typecheck` builds `@snaglet/shared` before it checks the other packages. To
  typecheck a single package with `pnpm --filter`, run
  `pnpm --filter @snaglet/shared build` first.

## Coding standards

Follow [Conventions](docs/conventions.md). In short: strict TypeScript, no
`any`, `getErrorMessage(err)` in catch blocks, `safeJsonParse` for untrusted
JSON, and tests in proportion to the behavior you change.

## Documentation

Docs describe what the code does now, in present tense. Proposals, plans and
notes belong in issues and pull requests, not in the repository. When you
change behavior, update the closest doc, and add any new doc to
[docs/INDEX.md](docs/INDEX.md). For a change users will notice, add a line to
[CHANGELOG.md](CHANGELOG.md) under the `[Unreleased]` heading.

`pnpm lint:docs` (part of `pnpm lint`) checks every tracked markdown file. It
fails on:

- personal paths such as a home folder with a real user name;
- real-looking node ids (placeholders repeat one digit:
  `doc-1111111111111-aaaaaaaaa`);
- placeholder words such as `TODO` in prose;
- plan or history wording;
- broken relative links and heading anchors;
- docs under `docs/` that `docs/INDEX.md` does not link;
- tracked files under `docs/plans/` or `docs/notes/`;
- images under `docs/` that no doc links;
- `pnpm` commands that name a script no `package.json` defines.

The rules live in `scripts/lib/docsGate.ts`.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org), for example
`fix(socket): release active run lock on abort`.

Before you open a pull request, bring your branch up to date with the default
branch, run the checks above for what you touched, and update the docs.

## Security

Do not report security issues in public issues. Follow [SECURITY.md](SECURITY.md).
