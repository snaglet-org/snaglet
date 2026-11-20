import path from 'path';
import { HookRegistrations } from '@snaglet/db/tables/hook_registrations';
import type { HookRegistrationRow } from '@snaglet/db/tables/hook_registrations';
import { CUSTOM_HOOKS_DIR } from '@server/services/customHooks/HookRegistryService';
import { ensureHookAuthoringSupport } from '@server/services/customHooks/hookAuthoringSupport';
import { SNAGLET_SDK_RUNTIME_DIR } from '@server/services/snagletHome';
import {
  HOOK_EVENT_NAMES,
  type AuthoredHookEventName,
} from '@server/services/ToolService/customTools/vendorSdk';
import type { ToolHandler } from '@server/services/ToolService/types';
import { writeHookScaffold } from '@server/services/ToolService/handlers/hooks/scaffold';

const REGISTRATION_TIMEOUT_MS = 20_000;
const REGISTRATION_POLL_MS = 100;

/**
 * Same override the REST hook workspace honors, so a scaffold lands in the
 * directory the running scanner is actually watching.
 */
function hooksDir(): string {
  return process.env.HOOK_WORKSPACES_DIR ?? CUSTOM_HOOKS_DIR;
}

/** Mirrors HookRegistryService's split between the real home and a test dir. */
function sdkTypesDir(dir: string): string {
  return dir === CUSTOM_HOOKS_DIR
    ? SNAGLET_SDK_RUNTIME_DIR
    : path.join(dir, '.snaglet-runtime', 'sdk');
}

function parseEvents(raw: unknown): AuthoredHookEventName[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('events must be an array of lifecycle event names');
  const allowed = new Set<string>(HOOK_EVENT_NAMES);
  return raw.map((entry) => {
    if (typeof entry !== 'string' || !allowed.has(entry)) {
      throw new Error(
        `Unknown hook event ${JSON.stringify(entry)}. Valid events: ${HOOK_EVENT_NAMES.join(', ')}`
      );
    }
    return entry as AuthoredHookEventName;
  });
}

/**
 * Wait for the scanner to reach a TERMINAL build state for this hook.
 *
 * Unlike `create_tool` — which can only time out and point at the server log —
 * the hook registry persists `build_status` and `last_error`, so a compile
 * failure comes back to the agent as the actual compiler diagnostics. That is
 * what makes an agent able to iterate on its own hook source.
 */
async function waitForRegistration(hookName: string): Promise<HookRegistrationRow> {
  const deadline = Date.now() + REGISTRATION_TIMEOUT_MS;
  let last: HookRegistrationRow | null = null;
  while (Date.now() < deadline) {
    last = await HookRegistrations.findByName(hookName);
    if (last?.buildStatus === 'ready') return last;
    if (last?.buildStatus === 'failed') {
      throw new Error(
        `Created ${hookName}, but it failed to build:\n${last.lastError ?? 'Unknown build error'}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, REGISTRATION_POLL_MS));
  }
  throw new Error(
    `Created ${hookName}, but the hook scanner did not finish registering it within ${REGISTRATION_TIMEOUT_MS}ms (last status: ${last?.buildStatus ?? 'undiscovered'}).`
  );
}

const tool: ToolHandler = async (input) => {
  const name = typeof input.name === 'string' ? input.name : '';
  const description = typeof input.description === 'string' ? input.description : '';
  if (input.hook_source !== undefined && typeof input.hook_source !== 'string') {
    throw new Error('hook_source must be a string');
  }
  const events = parseEvents(input.events);

  const dir = hooksDir();
  // Idempotent: guarantees tsconfig.json + the vendored @snaglet/sdk types sit
  // beside the file, so the agent can iterate on it with file_edit against
  // the full SDK surface.
  await ensureHookAuthoringSupport(dir, sdkTypesDir(dir));

  const created = await writeHookScaffold(dir, {
    name,
    description,
    events,
    hookSource: input.hook_source,
  });

  const row = await waitForRegistration(created.hookName);

  // Defense in depth, not the gate itself. The gate is that this tool only
  // ever creates a NEW folder: `discover` preserves `enabled` on conflict, so
  // a hook that could arrive here already enabled would have to be one whose
  // name was free a moment ago, and its code would already be subscribed by
  // the time this ran. Refusing existing names upstream is what prevents that;
  // this assertion only catches a future regression in the disabled default.
  if (row.enabled) {
    throw new Error(
      `${created.hookName} registered ENABLED, which breaks the human review gate for agent-authored hooks. Turn it off in the Automations view (scripts are listed there) and report this.`
    );
  }

  return JSON.stringify({
    path: created.folderPath,
    hook_name: created.hookName,
    registered: true,
    enabled: false,
    build_status: row.buildStatus,
    activation:
      'Registered but disabled: it will not run from lifecycle events or schedules until a person turns it on in the Automations view, where it is listed as a script. You can still test it now with hook(op: run, force: true).',
  });
};

export default tool;
