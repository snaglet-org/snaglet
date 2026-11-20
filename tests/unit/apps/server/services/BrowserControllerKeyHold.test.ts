/**
 * Held keys for the browser tool's press op: input checks and the hold
 * itself (keys go down in order, stay down, and are always released).
 */
import path from 'node:path';
import {
  MAX_HOLD_KEYS,
  MAX_HOLD_MS,
  OwedKeyups,
  parseHold,
  pressAndHold,
} from '@server/services/BrowserController/keyHold';

describe('parseHold', () => {
  it.each([
    { key: 'a' },
    { key: 'Enter' },
    { key: 'Control+a' },
    { key: 'Shift+Tab' },
    { key: 'Tab' },
    { key: 'a', keys: null, hold_ms: null },
    { key: 'a', keys: [] },
  ])('leaves a tap alone: %j', (input) => {
    expect(parseHold(input)).toBeNull();
  });

  it.each([
    [{ key: 'd', hold_ms: 500 }, ['d'], 500],
    [{ keys: ['w', 'd'], hold_ms: 500 }, ['w', 'd'], 500],
    [{ keys: ['ArrowUp', 'ArrowRight'], hold_ms: 1 }, ['ArrowUp', 'ArrowRight'], 1],
    [{ keys: ['Shift', 'KeyD', 'Space', 'Digit1'], hold_ms: MAX_HOLD_MS }, null, MAX_HOLD_MS],
    [{ key: ' ', hold_ms: 10 }, [' '], 10],
    [{ key: '', keys: ['w'], hold_ms: 5 }, ['w'], 5],
    [{ key: 'd', keys: [], hold_ms: 5 }, ['d'], 5],
  ])('accepts %j', (input, keys, ms) => {
    expect(parseHold(input)).toEqual({ keys: keys ?? (input as { keys: string[] }).keys, ms });
  });

  it.each([
    [{ hold_ms: 500 }, /key or keys/],
    [{ key: '', hold_ms: 500 }, /key or keys/],
    [{ keys: [], hold_ms: 500 }, /key or keys/],
    [{ keys: ['w', 'd'] }, /hold_ms/],
    [{ key: 'd', keys: ['w'], hold_ms: 500 }, /not both/],
    [{ key: 'd', hold_ms: 0 }, /hold_ms/],
    [{ key: 'd', hold_ms: -5 }, /hold_ms/],
    [{ key: 'd', hold_ms: 1.5 }, /hold_ms/],
    [{ key: 'd', hold_ms: '500' }, /hold_ms/],
    [{ key: 'd', hold_ms: Number.NaN }, /hold_ms/],
    [{ key: 'd', hold_ms: MAX_HOLD_MS + 1 }, /hold_ms/],
    [{ keys: 'wd', hold_ms: 500 }, /1-4/],
    [{ keys: ['a', 'b', 'c', 'd', 'e'], hold_ms: 500 }, /1-4/],
    [{ keys: ['w', ''], hold_ms: 500 }, /empty/],
    [{ keys: ['w', 5], hold_ms: 500 }, /empty|string/],
    [{ keys: ['NotAKey'], hold_ms: 500 }, /unknown key "NotAKey"/],
    [{ key: 'enter', hold_ms: 500 }, /unknown key "enter"/],
    [{ key: 'é', hold_ms: 500 }, /unknown key/],
    [{ key: 'Control+a', hold_ms: 500 }, /keys:\["Control","a"\]/],
    [{ keys: ['w', 'w'], hold_ms: 500 }, /same key/],
    [{ keys: ['d', 'D'], hold_ms: 500 }, /same key/],
    [{ keys: ['d', 'KeyD'], hold_ms: 500 }, /same key/],
    [{ keys: ['1', '!'], hold_ms: 500 }, /same key/],
    [{ keys: ['Shift', 'ShiftLeft'], hold_ms: 500 }, /same key/],
    [{ keys: [' ', 'Space'], hold_ms: 500 }, /same key/],
    [{ key: 'Tab', hold_ms: 500 }, /Tab moves focus/],
    [{ keys: ['Shift', 'Tab'], hold_ms: 500 }, /Tab moves focus/],
    [{ keys: ['Tab', 'Enter'], hold_ms: 500 }, /Tab moves focus/],
  ])('rejects %j', (input, error) => {
    const r = parseHold(input as Record<string, unknown>);
    expect(r).toEqual({ error: expect.stringMatching(error) });
  });

  it('caps simultaneous keys at MAX_HOLD_KEYS', () => {
    expect(MAX_HOLD_KEYS).toBe(4);
    expect(parseHold({ keys: ['w', 'a', 's', 'd'], hold_ms: 5 })).toEqual({
      keys: ['w', 'a', 's', 'd'],
      ms: 5,
    });
  });
});

describe('hold keys follow Playwright’s US keyboard layout', () => {
  // The layout Playwright resolves key names against (playwright-core's
  // Keyboard._keyDescriptionForString): codes, unlocated single-character
  // keys and their shifted characters, plus the modifier aliases.
  const pwDir = path.dirname(require.resolve('playwright-core/package.json'));
  const layout = require(path.join(pwDir, 'lib/server/usKeyboardLayout.js'))
    .USKeyboardLayout as Record<string, { key: string; shiftKey?: string; location?: number }>;
  const pw = new Map<string, string>();
  for (const [code, d] of Object.entries(layout)) {
    pw.set(code, code);
    if (d.location) continue;
    if (d.key.length === 1) pw.set(d.key, code);
    if (d.shiftKey) pw.set(d.shiftKey, code);
  }
  for (const [code, alias] of [
    ['ShiftLeft', 'Shift'],
    ['ControlLeft', 'Control'],
    ['AltLeft', 'Alt'],
    ['MetaLeft', 'Meta'],
  ]) {
    pw.set(alias, code);
  }
  pw.set('ControlOrMeta', process.platform === 'darwin' ? 'MetaLeft' : 'ControlLeft');
  const holdable = [...pw.entries()].filter(([, code]) => code !== 'Tab');

  it.each(holdable)('%j is accepted and is the same key as %s', (name, code) => {
    expect(parseHold({ key: name, hold_ms: 1 })).toEqual({ keys: [name], ms: 1 });
    if (name !== code) {
      expect(parseHold({ keys: [name, code], hold_ms: 1 })).toEqual({
        error: expect.stringMatching(/same key/),
      });
    }
  });

  it('accepts every printable ASCII character and nothing Playwright would refuse', () => {
    for (let c = 0x20; c <= 0x7e; c += 1) {
      const ch = String.fromCharCode(c);
      expect([ch, pw.has(ch)]).toEqual([ch, true]);
      expect(parseHold({ key: ch, hold_ms: 1 })).toEqual({ keys: [ch], ms: 1 });
    }
    for (const bad of ['enter', 'Ctrl', 'Cmd', 'Fn', 'Clear', '\n', 'é', 'KeyAA']) {
      expect(pw.has(bad)).toBe(false);
      expect(parseHold({ key: bad, hold_ms: 1 })).toEqual({
        error: expect.stringMatching(/unknown key/),
      });
    }
  });
});

/** A keyboard that records what reaches the page, with switchable failures. */
function fakeKeyboard() {
  const log: string[] = [];
  const kb = {
    log,
    failDown: new Set<string>(),
    failUp: new Set<string>(),
    hangDown: new Set<string>(),
    hangUp: new Set<string>(),
    hung: [] as Array<{ reject: (e: Error) => void }>,
    async down(k: string) {
      if (kb.failDown.has(k)) throw new Error(`down ${k} failed`);
      if (kb.hangDown.has(k)) {
        await new Promise<void>((_resolve, reject) => kb.hung.push({ reject }));
      }
      log.push(`down ${k}`);
    },
    async up(k: string) {
      if (kb.hangUp.has(k)) {
        log.push(`up ${k} (hangs)`);
        await new Promise<void>(() => undefined);
      }
      if (kb.failUp.has(k)) {
        log.push(`up ${k} (failed)`);
        throw new Error('Target page, context or browser has been closed');
      }
      log.push(`up ${k}`);
    },
  };
  return kb;
}

describe('pressAndHold', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('presses in order, holds for ms, releases in reverse, leaves no timer', async () => {
    const kb = fakeKeyboard();
    let done = false;
    const p = pressAndHold(kb, ['w', 'd'], 500).then((r) => {
      done = true;
      return r;
    });
    await jest.advanceTimersByTimeAsync(499);
    expect(kb.log).toEqual(['down w', 'down d']);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ end: 'done', heldMs: 500, pressed: ['w', 'd'] });
    expect(kb.log).toEqual(['down w', 'down d', 'up d', 'up w']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('when a later key fails, releases every key it tried (that one too), then rethrows', async () => {
    const kb = fakeKeyboard();
    kb.failDown.add('d');
    await expect(pressAndHold(kb, ['w', 'd', 's'], 500)).rejects.toThrow('down d failed');
    // Playwright marks a key pressed before it dispatches the key-down, so the
    // failed key gets a release too; s was never tried.
    expect(kb.log).toEqual(['down w', 'up d', 'up w']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('an abort mid-hold releases at once and detaches the listener', async () => {
    const kb = fakeKeyboard();
    const ac = new AbortController();
    const remove = jest.spyOn(ac.signal, 'removeEventListener');
    const p = pressAndHold(kb, ['w', 'd'], 5_000, { signal: ac.signal });
    await jest.advanceTimersByTimeAsync(200);
    ac.abort();
    expect(await p).toEqual({ end: 'aborted', heldMs: 200, pressed: ['w', 'd'] });
    expect(kb.log).toEqual(['down w', 'down d', 'up d', 'up w']);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(jest.getTimerCount()).toBe(0);
  });

  it('an already-aborted signal presses nothing', async () => {
    const kb = fakeKeyboard();
    const ac = new AbortController();
    ac.abort();
    expect(await pressAndHold(kb, ['w'], 500, { signal: ac.signal })).toEqual({
      end: 'aborted',
      heldMs: 0,
      pressed: [],
    });
    expect(kb.log).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each<'closed' | 'dialog'>(['closed', 'dialog'])(
    'a %s interrupt ends the hold, still tries every release, and unsubscribes',
    async (why) => {
      const kb = fakeKeyboard();
      let fire: (e: 'closed' | 'dialog') => void = () => undefined;
      const off = jest.fn();
      const p = pressAndHold(kb, ['w', 'a', 'd'], 5_000, {
        onInterrupt: (cb) => {
          fire = cb;
          return off;
        },
      });
      await jest.advanceTimersByTimeAsync(100);
      kb.failUp.add('a');
      fire(why);
      expect(await p).toEqual({ end: why, heldMs: 100, pressed: ['w', 'a', 'd'] });
      expect(kb.log).toEqual(['down w', 'down a', 'down d', 'up d', 'up a (failed)', 'up w']);
      expect(off).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  it('does not wait on a key-down the page never acknowledges once stopped', async () => {
    const kb = fakeKeyboard();
    kb.hangDown.add('d');
    const ac = new AbortController();
    const p = pressAndHold(kb, ['w', 'd', 's'], 5_000, { signal: ac.signal });
    await jest.advanceTimersByTimeAsync(50);
    ac.abort();
    // s was never tried, so it is not reported as pressed.
    expect(await p).toEqual({ end: 'aborted', heldMs: 0, pressed: ['w', 'd'] });
    expect(kb.log).toEqual(['down w', 'up d', 'up w']);
    // The abandoned key-down settling later must not surface as an unhandled rejection.
    kb.hung[0].reject(new Error('Target page, context or browser has been closed'));
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a release that never settles is given up after 1 s; the rest still go, in order', async () => {
    const kb = fakeKeyboard();
    kb.hangUp.add('d');
    let done = false;
    const p = pressAndHold(kb, ['w', 'd'], 100).then((r) => {
      done = true;
      return r;
    });
    await jest.advanceTimersByTimeAsync(100);
    expect(kb.log).toEqual(['down w', 'down d', 'up d (hangs)']);
    await jest.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ end: 'done' });
    expect(kb.log).toEqual(['down w', 'down d', 'up d (hangs)', 'up w']);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('OwedKeyups', () => {
  /** A dialog that closes when the test says so, like page.evaluate during an alert. */
  function dialogWatch() {
    let close: () => void = () => undefined;
    let fail: (e: Error) => void = () => undefined;
    const closed = new Promise<void>((resolve, reject) => {
      close = resolve;
      fail = reject;
    });
    return { closed: () => closed, close: () => close(), fail: (e: Error) => fail(e) };
  }

  it('releases the owed keys (in reverse) once the dialog closes, however it closed', async () => {
    const kb = fakeKeyboard();
    const w = dialogWatch();
    const owed = new OwedKeyups(kb, w.closed);
    owed.add(['w', 'd']);
    await Promise.resolve();
    expect(kb.log).toEqual([]);
    w.close();
    await new Promise((r) => setImmediate(r));
    expect(kb.log).toEqual(['up d', 'up w']);
  });

  it('op:dialog releases them even when handling the dialog throws, and only once', async () => {
    const kb = fakeKeyboard();
    const w = dialogWatch();
    const owed = new OwedKeyups(kb, w.closed);
    owed.add(['w', 'd']);
    await expect(
      owed.afterHandling(async () => {
        throw new Error('Cannot dismiss dialog which is already handled!');
      })
    ).rejects.toThrow('already handled');
    expect(kb.log).toEqual(['up d', 'up w']);
    w.close();
    await new Promise((r) => setImmediate(r));
    await owed.afterHandling(async () => undefined);
    expect(kb.log).toEqual(['up d', 'up w']);
  });

  it('a wait that fails (closed page, navigation) still releases, once', async () => {
    const kb = fakeKeyboard();
    const w = dialogWatch();
    const owed = new OwedKeyups(kb, w.closed);
    owed.add(['w', 'd']);
    w.fail(new Error('Execution context was destroyed'));
    await new Promise((r) => setImmediate(r));
    expect(kb.log).toEqual(['up d', 'up w']);
    // Nothing stays owed for a later, unrelated op:dialog to send.
    await owed.afterHandling(async () => undefined);
    expect(kb.log).toEqual(['up d', 'up w']);
  });

  it('a failing release skips none', async () => {
    const kb = fakeKeyboard();
    const owed = new OwedKeyups(kb, () => new Promise(() => undefined));
    kb.failUp.add('d');
    owed.add(['w', 'd', 's']);
    await owed.afterHandling(async () => undefined);
    expect(kb.log).toEqual(['up s', 'up d (failed)', 'up w']);
  });
});
