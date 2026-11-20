/**
 * Held keys for op:press with hold_ms: input checks (key names Playwright's
 * keyboard accepts, US layout) and the hold itself, which releases every key
 * it pressed however it ends.
 */
import type { HoldOutcome } from './types';

/** Longest single hold: long enough for a drawn stroke, short enough to stop quickly. */
export const MAX_HOLD_MS = 5_000;
export const MAX_HOLD_KEYS = 4;
/** All holds in one batch together; keeps a call far below the tool timeout. */
export const MAX_BATCH_HOLD_MS = 15_000;

/** Characters per physical key: unshifted, then shifted. */
const CHAR_KEYS: Array<[code: string, chars: string]> = [
  ['Backquote', '`~'],
  ['Digit1', '1!'],
  ['Digit2', '2@'],
  ['Digit3', '3#'],
  ['Digit4', '4$'],
  ['Digit5', '5%'],
  ['Digit6', '6^'],
  ['Digit7', '7&'],
  ['Digit8', '8*'],
  ['Digit9', '9('],
  ['Digit0', '0)'],
  ['Minus', '-_'],
  ['Equal', '=+'],
  ['Backslash', '\\|'],
  ['BracketLeft', '[{'],
  ['BracketRight', ']}'],
  ['Semicolon', ';:'],
  ['Quote', `'"`],
  ['Comma', ',<'],
  ['Period', '.>'],
  ['Slash', '/?'],
  ['Space', ' '],
];

const NAMED_CODES = [
  'Escape',
  'Backspace',
  'Tab',
  'CapsLock',
  'Enter',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'AltGraph',
  'MetaLeft',
  'MetaRight',
  'ContextMenu',
  'PrintScreen',
  'ScrollLock',
  'Pause',
  'Insert',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowLeft',
  'ArrowUp',
  'ArrowRight',
  'ArrowDown',
  'NumLock',
  'NumpadDivide',
  'NumpadMultiply',
  'NumpadSubtract',
  'NumpadAdd',
  'NumpadDecimal',
  'NumpadEnter',
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
];

/** Key name -> the physical key (KeyboardEvent.code) it presses. */
const CODES = new Map<string, string>([
  ...NAMED_CODES.map((c): [string, string] => [c, c]),
  ['Shift', 'ShiftLeft'],
  ['Control', 'ControlLeft'],
  ['Alt', 'AltLeft'],
  ['Meta', 'MetaLeft'],
  ['ControlOrMeta', process.platform === 'darwin' ? 'MetaLeft' : 'ControlLeft'],
]);
for (const [code, chars] of CHAR_KEYS) {
  CODES.set(code, code);
  for (const ch of chars) CODES.set(ch, code);
}
for (let i = 0; i < 26; i += 1) {
  const lower = String.fromCharCode(97 + i);
  const code = `Key${lower.toUpperCase()}`;
  CODES.set(code, code);
  CODES.set(lower, code);
  CODES.set(lower.toUpperCase(), code);
}

/** The physical key a Playwright key name presses; undefined when Playwright would refuse it. */
function keyCode(name: string): string | undefined {
  return CODES.get(name);
}

interface HoldSpec {
  keys: string[];
  ms: number;
}

/**
 * Reads press input. null = no hold asked (a plain tap: `key` alone, chords
 * included). Otherwise the keys to hold and for how long, or why not.
 */
export function parseHold(input: Record<string, unknown>): HoldSpec | { error: string } | null {
  // null, "" and [] count as absent: some providers fill every optional parameter.
  const key = input.key === '' ? undefined : (input.key ?? undefined);
  const keys =
    Array.isArray(input.keys) && input.keys.length === 0 ? undefined : (input.keys ?? undefined);
  const ms = input.hold_ms ?? undefined;
  if (keys === undefined && ms === undefined) return null;
  if (ms === undefined) return { error: 'keys needs hold_ms: how long to hold them' };
  if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 1 || ms > MAX_HOLD_MS) {
    return { error: `hold_ms must be a whole number of milliseconds, 1-${MAX_HOLD_MS}` };
  }
  if (keys !== undefined && key !== undefined) return { error: 'give key or keys, not both' };
  if (keys === undefined && (typeof key !== 'string' || key === '')) {
    return { error: 'hold_ms needs key or keys, e.g. key:"d" or keys:["w","d"]' };
  }
  const list: unknown[] = keys === undefined ? [key] : Array.isArray(keys) ? keys : [];
  if (list.length < 1 || list.length > MAX_HOLD_KEYS) {
    return { error: `keys takes 1-${MAX_HOLD_KEYS} key names held together` };
  }
  const seen = new Map<string, string>();
  for (const k of list) {
    if (typeof k !== 'string' || k === '') {
      return { error: 'keys must be non-empty key names, e.g. "d" or "ArrowUp"' };
    }
    const code = keyCode(k);
    if (!code) {
      if (k.length > 1 && k.includes('+')) {
        return {
          error: `"${k}" is a chord; to hold several keys list each one: keys:${JSON.stringify(k.split('+'))}`,
        };
      }
      return {
        error: `unknown key "${k}": use a single character or a key name like ArrowUp, Shift, Space, Enter`,
      };
    }
    if (code === 'Tab') {
      // Focus would move mid-hold, past the checks made on the focused field.
      return { error: 'Tab moves focus, so it cannot be held; tap it with press key:"Tab"' };
    }
    const prev = seen.get(code);
    if (prev !== undefined) return { error: `"${prev}" and "${k}" are the same key` };
    seen.set(code, k);
  }
  return { keys: list as string[], ms };
}

type HoldEnd = HoldOutcome['end'];

interface KeyboardPort {
  down(key: string): Promise<void>;
  up(key: string): Promise<void>;
}

interface HoldOptions {
  /** The run's signal: aborting ends the hold at once. */
  signal?: AbortSignal;
  /** Subscribes to page events that end the hold early; returns the unsubscribe. */
  onInterrupt?: (cb: (end: 'closed' | 'dialog') => void) => () => void;
}

const quiet = (): undefined => undefined;

/** How long one key release may take before the next goes anyway (a wedged page). */
const RELEASE_TIMEOUT_MS = 1_000;

/** Releases `keys` in the order given; never throws, never waits more than 1 s per key. */
async function releaseAll(kb: KeyboardPort, keys: readonly string[]): Promise<void> {
  for (const k of keys) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      kb.up(k).catch(quiet),
      new Promise((resolve) => {
        timer = setTimeout(resolve, RELEASE_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
  }
}

/**
 * Presses `keys` in order, keeps them down for `ms`, then releases them in
 * reverse. Abort or an interrupt ends the hold early, without waiting on a
 * key-down the page has not acknowledged. Every key it tried to press
 * (`pressed`) gets a release attempt; a release that fails or hangs (closed
 * page, lost browser) does not stop the rest. A failing key-down is rethrown
 * after the releases.
 */
export async function pressAndHold(
  kb: KeyboardPort,
  keys: readonly string[],
  ms: number,
  o: HoldOptions = {}
): Promise<HoldOutcome & { pressed: string[] }> {
  let ended: HoldEnd | undefined;
  let wake: (end: HoldEnd) => void = quiet;
  const woken = new Promise<HoldEnd>((resolve) => {
    wake = resolve;
  });
  const end = (why: HoldEnd) => {
    ended ??= why;
    wake(ended);
  };
  const onAbort = () => end('aborted');
  const unsubscribe = o.onInterrupt?.(end);
  if (o.signal?.aborted) end('aborted');
  else o.signal?.addEventListener('abort', onAbort, { once: true });
  const pressed: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (const k of keys) {
      if (ended) break;
      pressed.push(k);
      const down = kb.down(k);
      down.catch(quiet);
      await Promise.race([down, woken]);
    }
    if (ended) return { end: ended, heldMs: 0, pressed: [...pressed] };
    const start = Date.now();
    timer = setTimeout(() => end('done'), ms);
    const why = await woken;
    return { end: why, heldMs: Date.now() - start, pressed: [...pressed] };
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onAbort);
    unsubscribe?.();
    await releaseAll(kb, [...pressed].reverse());
  }
}

/**
 * Releases owed for keys let go while a JS dialog was open: Chromium drops
 * key events until the dialog closes, so the page would keep those keys down.
 * They are sent once `dialogClosed` settles (every frame runs script again,
 * however the dialog was closed; a failure such as a navigation counts too),
 * or after op:dialog handles it, whichever comes first; each key once.
 */
export class OwedKeyups {
  private keys: string[] = [];

  constructor(
    private readonly kb: KeyboardPort,
    private readonly dialogClosed: () => Promise<unknown>
  ) {}

  /** `keys` in the order they went down. */
  add(keys: readonly string[]): void {
    for (const k of keys) if (!this.keys.includes(k)) this.keys.push(k);
    const flush = () => this.flush();
    this.dialogClosed().then(flush, flush);
  }

  /** Runs op:dialog's accept or dismiss, then sends what is owed even if that throws. */
  async afterHandling(handle: () => Promise<void>): Promise<void> {
    try {
      await handle();
    } finally {
      await this.flush();
    }
  }

  private async flush(): Promise<void> {
    const keys = this.keys.reverse();
    this.keys = [];
    await releaseAll(this.kb, keys);
  }
}
