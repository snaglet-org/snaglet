/**
 * The hook event list exists in two places that cannot import each other:
 * packages/snaglet-sdk/src/index.ts (the published contract external authors
 * compile against) and vendorSdk.ts (what this server vendors into a hook
 * build and offers in hook(op:create)). Inside the server vendorSdk's tuple is
 * the single source; across the package boundary only this test keeps them
 * equal. Drift is quiet: an agent writes a hook for an event that never fires.
 */

import { describe, it, expect } from '@jest/globals';
import {
  HOOK_EVENT_NAMES as VENDORED_EVENTS,
  SDK_RUNTIME_SOURCE,
} from '@server/services/ToolService/customTools/vendorSdk';
import createHookDefinition from '@server/services/ToolService/tools/hooks/hook/definition';
import { HOOK_EVENT_NAMES as PUBLISHED_EVENTS } from '../../../../../../packages/snaglet-sdk/src';

describe('hook event contract', () => {
  it('vendored events match the published @snaglet/sdk contract exactly', () => {
    // Order matters as much as membership: both are surfaced to authors as a
    // list, and a reordering diff is a signal someone edited one side only.
    expect([...VENDORED_EVENTS]).toEqual([...PUBLISHED_EVENTS]);
  });

  it('the runtime source a hook imports declares that same list', () => {
    // The vendored text is what `import { HOOK_EVENT_NAMES } from '@snaglet/sdk'`
    // resolves to inside a built hook. It is generated from the tuple above,
    // so this pins the generation rather than a hand-copied literal.
    const emitted = `export const HOOK_EVENT_NAMES = [\n${VENDORED_EVENTS.map(
      (name) => `  '${name}',`
    ).join('\n')}\n];`;
    expect(SDK_RUNTIME_SOURCE).toContain(emitted);
  });

  it('hook(op:create) offers exactly the authorable events, no more', () => {
    const events = createHookDefinition.parameters_schema?.properties?.events as
      | { items?: { enum?: string[] } }
      | undefined;
    expect(events?.items?.enum).toEqual([...PUBLISHED_EVENTS]);
  });

  it('does not expose administration events to authored hook code', () => {
    // The server bus also carries credential/model/provider/tool lifecycle
    // events. Those are internal plumbing; handing them to authored hook code
    // would widen what a hook can observe about the workspace's secrets and
    // configuration. Excluded deliberately, so a "sync the lists" change
    // cannot quietly pull them in.
    for (const name of VENDORED_EVENTS) {
      expect(name.startsWith('credential:')).toBe(false);
      expect(name.startsWith('model:')).toBe(false);
      expect(name.startsWith('provider:')).toBe(false);
      expect(name.startsWith('tool:')).toBe(false);
    }
  });
});
