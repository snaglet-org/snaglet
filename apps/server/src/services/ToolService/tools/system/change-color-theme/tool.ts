import {
  defaultWorkspaceColors,
  parseWorkspaceColors,
  readSavedWorkspaceColors,
  workspaceColorResetPatch,
  workspaceColorTokens,
} from '@snaglet/shared/constants/workspaceTheme';
import { isRecord } from '@snaglet/shared/utils';
import type { SettingsWriteActor } from '@snaglet/db/tables/settings';
import { getCurrentActor } from '@server/realtime/actorContext';
import { settingsService } from '@server/services/settings';
import { appearanceSettings } from '@server/services/settings/categories/appearance';
import type { ToolHandler, ToolHandlerContext } from '@server/services/ToolService/types';

const TOKEN_LIST = workspaceColorTokens.map((token) => token.name).join(', ');
const SHOWN_NOW = 'Open Snaglet windows show it now.';

function isToken(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(defaultWorkspaceColors, name);
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * A field a model filled in as a placeholder (`null`, `""`, `[]`, `{}`) counts
 * as left out: `{op: "get", colors: null}` is a get, not an error.
 */
function isPlaceholder(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return isRecord(value) && Object.keys(value).length === 0;
}

/** Every token's color as the app shows it now. */
async function readCurrentTheme(): Promise<Record<string, string>> {
  const stored = await settingsService.read(appearanceSettings.colors);
  return { ...defaultWorkspaceColors, ...readSavedWorkspaceColors(stored) };
}

/**
 * Who the write is by: the calling agent, or the person when they run the
 * tool themselves, including as an agent from the panel (act-as borrows the
 * agent's context only, so they stay the author).
 */
function writeActor(context: ToolHandlerContext | undefined): SettingsWriteActor {
  if (context?.agentId && !context.bypassToolAccess) return { agentId: context.agentId };
  const actor = getCurrentActor();
  return actor?.actorKind === 'user' ? { userId: actor.actorId } : {};
}

/**
 * Merge into the saved overrides as `PATCH /api/settings/appearance/colors`
 * (the Theme view's save and resets) does, on the same locked row: the given
 * tokens replace theirs, a token given as null loses its saved color (reset),
 * the rest stay, and a save landing at the same moment keeps its tokens too.
 * The write emits `settings:changed`, which every open window follows.
 */
async function mergeColors(
  colors: Record<string, string | null>,
  context: ToolHandlerContext | undefined
): Promise<void> {
  await settingsService.mergeEntries(appearanceSettings.colors, colors, writeActor(context));
}

/** `name old → new` for each token that changes, so one set can undo it. */
function describeChanges(
  current: Record<string, string>,
  colors: Record<string, string>,
  unchanged: (name: string, color: string) => string
): string[] {
  return Object.entries(colors).map(([name, color]) =>
    current[name] === color ? unchanged(name, color) : `${name} ${current[name]} → ${color}`
  );
}

function describeTheme(current: Record<string, string>): string {
  const customized = workspaceColorTokens.filter(
    (token) => current[token.name] !== token.defaultValue
  ).length;
  const lines = [
    `Snaglet color theme: ${workspaceColorTokens.length} tokens, ${customized} customized (marked *). ` +
      'Change with op set {colors: {token: "#rrggbb"}}; op reset puts tokens back to their defaults.',
  ];
  let category = '';
  for (const token of workspaceColorTokens) {
    if (token.category !== category) {
      category = token.category;
      lines.push(`${category}:`);
    }
    const value = current[token.name];
    const changed = value !== token.defaultValue;
    lines.push(
      `${changed ? '*' : ' '} ${token.name} ${value}${changed ? ` (default ${token.defaultValue})` : ''}` +
        ` — ${token.label}: ${token.description}`
    );
  }
  return lines.join('\n');
}

/** `colors` for op set: every entry valid, or an error naming the bad ones. */
function readSetColors(value: unknown): Record<string, string> {
  if (isPlaceholder(value) || !isRecord(value)) {
    throw new Error(
      `set needs colors: {token: "#rrggbb", ...} with at least one token. Tokens: ${TOKEN_LIST}.`
    );
  }
  const unknown: string[] = [];
  const invalid: string[] = [];
  const colors: Record<string, string> = {};
  for (const [name, color] of Object.entries(value)) {
    if (!isToken(name)) {
      unknown.push(name);
      continue;
    }
    try {
      Object.assign(colors, parseWorkspaceColors({ [name]: color }));
    } catch {
      const shorthand = typeof color === 'string' && /^#[0-9a-f]{3}$/i.test(color.trim());
      const hint = shorthand
        ? ` (write #${[...color.trim().slice(1)].map((c) => c + c).join('')})`
        : '';
      invalid.push(`${name}=${JSON.stringify(color)}${hint}`);
    }
  }
  const problems = [
    ...(unknown.length
      ? [`unknown token${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`]
      : []),
    ...(invalid.length ? [`not a six-digit hex color "#rrggbb": ${invalid.join(', ')}`] : []),
  ];
  if (problems.length) {
    throw new Error(`Nothing changed. ${problems.join('; ')}. Valid tokens: ${TOKEN_LIST}.`);
  }
  return colors;
}

/** `tokens` for op reset: the named tokens, or null for every token (left out or a placeholder). */
function readResetTokens(value: unknown): string[] | null {
  if (isPlaceholder(value)) return null;
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string')) {
    throw new Error(
      `reset tokens must be a list of token names; leave tokens out to reset every token. Tokens: ${TOKEN_LIST}.`
    );
  }
  const unknown = (value as string[]).filter((name) => !isToken(name));
  if (unknown.length) {
    throw new Error(
      `Nothing changed. unknown token${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Valid tokens: ${TOKEN_LIST}.`
    );
  }
  return [...new Set(value as string[])];
}

/**
 * A filled-in field that belongs to another op is refused, so `reset` with
 * colors cannot reset everything; a placeholder is ignored.
 */
function refuseOtherOpFields(op: string, input: Record<string, unknown>): void {
  if (op !== 'set' && !isPlaceholder(input.colors)) throw new Error('colors is only for op set');
  if (op !== 'reset' && !isPlaceholder(input.tokens)) {
    throw new Error('tokens is only for op reset');
  }
}

const tool: ToolHandler = async (input, _settings, context) => {
  const op = input.op;
  if (op !== 'get' && op !== 'set' && op !== 'reset') {
    throw new Error('op must be get, set or reset');
  }
  refuseOtherOpFields(op, input);

  if (op === 'get') return describeTheme(await readCurrentTheme());

  if (op === 'set') {
    const colors = readSetColors(input.colors);
    const current = await readCurrentTheme();
    await mergeColors(colors, context);
    const changes = describeChanges(
      current,
      colors,
      (name, color) => `${name} ${color} (unchanged)`
    );
    return `Theme updated, ${plural(changes.length, 'color')}: ${changes.join(', ')}. ${SHOWN_NOW}`;
  }

  const listed = readResetTokens(input.tokens);
  const tokens = listed ?? Object.keys(defaultWorkspaceColors);
  const current = await readCurrentTheme();
  const defaults = Object.fromEntries(tokens.map((name) => [name, defaultWorkspaceColors[name]!]));
  // Remove the saved colors rather than saving today's defaults, so the reset
  // tokens keep following the default if it changes later.
  await mergeColors(workspaceColorResetPatch(tokens), context);
  if (listed) {
    const changes = describeChanges(
      current,
      defaults,
      (name, color) => `${name} ${color} (already the default)`
    );
    return `Reset ${plural(tokens.length, 'color')} to the default: ${changes.join(', ')}. ${SHOWN_NOW}`;
  }
  // Every token: list only the ones that changed, each with its old color, so
  // op set with those old colors undoes the reset.
  const changed = tokens.filter((name) => current[name] !== defaults[name]);
  if (changed.length === 0) return 'Every color was already its default; nothing changed.';
  const changes = describeChanges(
    current,
    Object.fromEntries(changed.map((name) => [name, defaults[name]!])),
    (name) => name
  );
  return (
    `Reset every color to its default; ${plural(changed.length, 'token')} changed: ` +
    `${changes.join(', ')}. ${SHOWN_NOW}`
  );
};

export default tool;
