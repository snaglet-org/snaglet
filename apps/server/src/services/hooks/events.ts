/**
 * Hook event catalog.
 *
 * The authored @snaglet/sdk list (`HOOK_EVENT_NAMES`) plus the two
 * hook-chaining events, `hook:finished` and `hook:signal`. Only these are kept
 * in the bus's recent-event ring (`hooks.recent`); credential, model, provider
 * and tool administration events are deliberately absent, exactly as they are
 * from the authored list.
 *
 * The two chaining events are not in the authored @snaglet/sdk list, which the
 * Hook Builder validates against.
 */

import { HOOK_EVENT_NAMES } from '@server/services/ToolService/customTools/vendorSdk';
import type { HookEventMap } from '@server/services/HookService';

/** The hook-chaining events, not on the authored list. */
const HOOKS_V2_ONLY_EVENTS = [
  'hook:finished',
  'hook:signal',
] as const satisfies readonly (keyof HookEventMap)[];

/** Every catalog event, in catalog order. */
export const HOOKS_V2_EVENT_NAMES: readonly (keyof HookEventMap)[] = [
  ...HOOK_EVENT_NAMES,
  ...HOOKS_V2_ONLY_EVENTS,
];

/** A signal name: lowercase, starts alphanumeric, at most 64 chars. */
export const SIGNAL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
