# Code conventions

The rules every change follows, with a few examples. TypeScript, ESLint
(`eslint.config.js`), Prettier and the tests enforce most of them; review covers
the rest.

## TypeScript

- No `any`; ESLint fails on it. Use `unknown` and narrow it, a precise type, or
  a generic.
- Strict mode is on. Handle `null` and `undefined`; do not silence the compiler
  with a non-null `!`.
- No unused locals or parameters. Prefix a parameter you must keep with `_`.
- Use `interface` for object shapes and `type` for unions and compositions.
- Use `import type` and `export type` for types.

## Imports and exports

Path aliases live in `tsconfig.base.json`:

| Alias                                  | Points at               |
| -------------------------------------- | ----------------------- |
| `@snaglet/shared`, `@snaglet/shared/*` | `packages/shared/`      |
| `@snaglet/db`, `@snaglet/db/*`         | `packages/db/`          |
| `@snaglet/sdk`                         | `packages/snaglet-sdk/` |
| `@snaglet/ui`                          | `packages/ui/src/`      |
| `@server/*`                            | `apps/server/src/`      |
| `@desktop/*`                           | `apps/desktop-ui/src/`  |

- Use an alias when an import leaves the current feature folder. Relative
  imports are for nearby files only.
- No file extensions in import or export paths; the build adds them. ESLint
  enforces this.
- No `/index` at the end of an import path.
- Shared components use named exports and are imported from their group
  barrel. Use a default export only when a framework requires one.
- Add a folder `index.ts` only when the folder has several public exports.

```ts
// good
import { logger } from '@server/config/logger';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Agents } from '@snaglet/db/tables/agents';
import { Button, TextInput } from '@desktop/components';
import { FieldLabel } from './FieldLabel';

// bad
import { logger } from '../../../config/logger';
import { TextInput } from '@desktop/components/controls/TextInput/TextInput';
import { Chip } from './Chip/index.ts';
export default Chip;
```

## Errors and logging

- Get an error's message with `getErrorMessage(err)` from `@snaglet/shared/utils`,
  not `String(err)` or `err.message`.
- Parse untrusted JSON with `safeJsonParse(json, fallback)`, not a bare
  `JSON.parse` inside `try`.
- Services throw the typed errors in `packages/shared/utils/errors.ts`
  (`AppError`, `AuthError`, `ConflictError`, `RateLimitError`). Routes and
  socket handlers catch them and send a structured response.
- Never swallow an error. ESLint rejects an empty `catch` block and
  `.catch(() => {})`.
- Server code logs with the winston logger in
  `apps/server/src/config/logger.ts`, not `console`.

```ts
import { logger } from '@server/config/logger';
import { AppError, ConflictError, getErrorMessage } from '@snaglet/shared/utils';

// service
if (existing) throw new ConflictError(`Table ${name} already exists`);

// route
try {
  res.json(await service.create(input));
} catch (err) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: getErrorMessage(err) });
  }
  logger.error('Unexpected error', { error: getErrorMessage(err) });
  return res.status(500).json({ error: 'Internal server error' });
}
```

## Where code goes

- A server feature lives in `apps/server/src/domains/<domain>/` (its routes,
  services and types). Services shared across features live in
  `apps/server/src/services/`.
- Keep route handlers small. Put logic in a domain service or a `packages/db`
  model.
- Data access goes through `packages/db` models and `getDbClient()` from
  `@snaglet/db`. Only `packages/db` imports the `pg` client.
- Keep a type next to its only user. Move it to an app's `src/types/` when the
  whole app uses it, and to `packages/shared/types/` only when more than one app
  or package does.
- Before you write a helper, look in `packages/shared/utils/`, the SCSS tokens
  in `apps/desktop-ui/src/styles/`, and the components in
  `apps/desktop-ui/src/components/` and `packages/ui/`.

## Unused code

`pnpm lint:baseline` compares ESLint and Knip findings with
`quality-baseline.json`. Fix new findings instead of raising the limits. Before
you delete an export, check its callers, tests, package entry points and
dynamically loaded modules.

## Comments

Comments explain why, not what, and describe the code as it is now.

- No history: no dates, PR numbers, migration numbers cited as history,
  "used to", "no longer" or the story of an old bug. Git keeps the history.
  Naming a migration file the code depends on is fine.
- No process notes: no review findings, tracker codes or names of the people
  and agents who wrote the code.
- No banners, box drawing or ALL-CAPS emphasis. A section label is one line.
- No commented-out code, and no comment that repeats the next line.
- Keep doc comments to a few lines. Keep security, data-loss and ordering
  invariants and real workarounds: state the rule and the reason.
- Test names describe behavior in sentence case.
- Spelling: American English in code, comments, docs and UI text (color,
  behavior, canceled, gray). `americanSpelling.guard.test.ts` enforces it.

## Test fixtures

- Tests rely only on what a fresh install creates: the migrations and the
  starter agents Snaglet seeds on first boot. A test creates every other row, node
  or file it checks.
- Fixture values are neutral placeholders that fit any user and any machine:
  `Test User`, `user@example.com`, `test-agent-a`. Placeholder ids repeat one
  digit, such as `doc-1111111111111-aaaaaaaaa`. Never use real people, personal
  paths or real-looking ids.
- No test may need a custom database seed or someone's local workspace.

## Commits

- Use [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope): message`, for example
  `fix(socket): release active run lock on abort`. Common types are `feat`,
  `fix`, `refactor`, `test`, `docs`, `build` and `chore`.
- Keep commits small and on one theme, and leave the tree green after each one.

## Check before you push

```bash
pnpm verify:changed
pnpm lint
pnpm typecheck:all
pnpm format:check
```
