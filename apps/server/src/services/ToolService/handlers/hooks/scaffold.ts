import { mkdir, rename, rm, stat, writeFile } from 'fs/promises';
import path from 'path';
import { BUILT_HOOK_RELATIVE } from '@server/services/customHooks/buildHookBundle';
import type { AuthoredHookEventName } from '@server/services/ToolService/customTools/vendorSdk';

const HOOK_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_HOOK_NAME_LENGTH = 64;

/**
 * The only file this scaffold will ever write into a hook folder.
 *
 * Deliberately narrow, for an activation reason rather than a tidiness one:
 * `HookRegistryService.registerHookFolder` enables a hook on first
 * registration when an in-folder build (`dist/hook.cjs`, the older layout) is
 * already present. Writing any build artifact here would therefore hand an
 * agent-authored hook an enabled registration and silently defeat the human
 * review gate. Source only: the scanner builds.
 */
const SCAFFOLD_FILE = 'hook.ts';

export interface CreateHookScaffoldInput {
  name: string;
  description: string;
  events?: readonly AuthoredHookEventName[];
  hookSource?: string;
}

export interface CreatedHookScaffold {
  folderPath: string;
  hookName: string;
}

/**
 * A compiling observer that does nothing but log. Mirrors `create_tool`'s
 * no-op default: the scaffold must build and register on the first pass, so
 * the agent gets a real registration (and a real build error if the toolchain
 * is unhappy) before it starts writing behavior.
 */
function defaultHookSource(
  name: string,
  description: string,
  events: readonly AuthoredHookEventName[]
): string {
  const on = events.map((event) => `'${event}'`).join(', ');
  return `import { defineHook, snaglet } from '@snaglet/sdk';

/**
 * ${name} — scaffolded by hook(op:create).
 *
 * ${description}
 *
 * Hooks are OBSERVERS: fire-and-forget, run in a crash-isolated child
 * process, and are killed at ~30s. Act on the workspace through
 * snaglet.tools.execute(); keep run() fast and idempotent.
 *
 * This scaffold only logs. Replace the body of run() with real behavior.
 * It is registered but DISABLED — a human turns it on from the Automations view.
 */
export default defineHook({
  on: [${on}],
  async run(event) {
    await snaglet.log.info(\`${name}: received \${event.type}\`);
  },
});
`;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function validateHookName(rawName: string): string {
  const name = rawName.trim();
  if (!HOOK_NAME.test(name) || name.length > MAX_HOOK_NAME_LENGTH) {
    throw new Error(
      'name must be 1-64 characters using lowercase letters, numbers, and single hyphens between segments'
    );
  }
  return name;
}

/**
 * Write a NEW hook folder through a sibling staging directory, so the
 * FolderScanner never observes a half-written `hook.ts`. The staging directory
 * is dot-prefixed because `FolderScanner.reconcile` skips dotfolders — that is
 * what makes the rename, rather than the individual writes, the moment the
 * hook becomes visible.
 *
 * There is deliberately NO overwrite mode, because replacing an existing hook
 * would be an activation escape hatch rather than a convenience:
 * `HookRegistrations.discover` preserves `enabled` across re-registration (its
 * ON CONFLICT updates only source_path/updated_at), so writing new code into a
 * folder a person had already enabled would put that code straight onto the
 * live event bus — subscribed before any caller could inspect the result. It
 * would also destroy the existing hook's source wholesale.
 *
 * Iterating on an existing hook is a targeted `file(op:update)` against its
 * `hook.ts`, which keeps the human's enablement decision attached to code they
 * chose to keep.
 */
export async function writeHookScaffold(
  hooksDir: string,
  input: CreateHookScaffoldInput
): Promise<CreatedHookScaffold> {
  const name = validateHookName(input.name);
  const description = input.description.trim();
  if (!description) throw new Error('description is required');

  const hookSource = input.hookSource?.trim() ? input.hookSource : undefined;
  const events = input.events ?? [];
  if (!hookSource && events.length === 0) {
    // defineHook rejects a definition with neither `on` nor `schedule`, so a
    // scaffold without either would land on disk and then fail registration
    // with a confusing error. Refuse up front instead.
    throw new Error(
      'Provide events (the lifecycle events this hook observes) or hook_source containing a complete defineHook definition with `on` or `schedule`.'
    );
  }

  const folderPath = path.join(hooksDir, name);
  await mkdir(hooksDir, { recursive: true });
  if (await pathExists(folderPath)) {
    throw new Error(
      `Hook "${name}" already exists at ${folderPath}. hook(op: create) only creates new hooks. ` +
        `To change this one, edit ${path.join(folderPath, SCAFFOLD_FILE)} with file(op:update), or use hook(op: update); ` +
        'to make a different hook, choose another name.'
    );
  }

  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stagingPath = path.join(hooksDir, `.${name}.create-${nonce}`);

  try {
    await mkdir(stagingPath, { recursive: false });
    await writeFile(
      path.join(stagingPath, SCAFFOLD_FILE),
      hookSource ?? defaultHookSource(name, description, events)
    );
    // rename() onto an existing directory would fail anyway, but the check
    // above is what makes the refusal a clear message instead of an ENOTEMPTY.
    await rename(stagingPath, folderPath);
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true });
    throw error;
  }

  return { folderPath, hookName: name };
}

/** Exported for the test that pins the no-build-artifact invariant. */
export const LEGACY_BUILD_RELATIVE = BUILT_HOOK_RELATIVE;
