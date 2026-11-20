import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLOWER_HANDOFF_MS, FLOWER_SETTLE_MS } from '@snaglet/shared/constants/agentCursor';

/**
 * The full-screen cursor overlay window must stay strictly click-through: an
 * interactive overlay can lock the user's screen, so these invariants are pinned.
 * The only windows that take the mouse are the small flower panels, and only while
 * the page reports their flower as settled; their limits are pinned here too.
 */
const file = join(process.cwd(), 'apps/server/native/cursor-overlay/CursorOverlay.swift');
const src = readFileSync(file, 'utf8');
// Ignore comments so documentation may mention the forbidden names.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n');

/** Body of the first `{ ... }` block after `header` (brace-matched). */
function block(header: string): string {
  const at = code.indexOf(header);
  expect(at).toBeGreaterThanOrEqual(0);
  const open = code.indexOf('{', at + header.length);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return code.slice(open, i + 1);
  }
  throw new Error(`unbalanced block after ${header}`);
}

const constant = (name: string): number => {
  const m = new RegExp(`let ${name}(?::\\s*\\w+)?\\s*=\\s*([\\d.]+)`).exec(code);
  expect(m).not.toBeNull();
  return Number(m?.[1]);
};

/**
 * Every mention of ignoresMouseEvents, each of which must be a whole-line literal assignment
 * (`window.ignoresMouseEvents = true`), so no computed value, ternary or key path can slip by.
 */
const mentions = code.match(/ignoresmouseevents/gi) ?? [];
const mouseAssignments = [
  ...code.matchAll(/^[ \t]*(\w+)\.ignoresMouseEvents = (true|false)[ \t]*$/gm),
].map((m) => ({ receiver: m[1], value: m[2] }));

describe('cursor overlay safety: the full-screen window', () => {
  it('only ever sets ignoresMouseEvents to a literal, on its own line, never through KVC', () => {
    // Any spelling counts (setIgnoresMouseEvents:, a selector string, a key path).
    expect(mentions.length).toBe(mouseAssignments.length);
    expect(code).not.toMatch(/#keyPath|NSSelectorFromString|\bperform\(|#selector\(\s*set/);
    // The one KVC call is the web view's background, exactly as written (the other
    // setValue is an HTTP header on the stop request).
    const setValues = (code.match(/^.*setValue\(.*$/gm) ?? []).map((l) => l.trim());
    expect(setValues.sort()).toEqual([
      'if !authToken.isEmpty { request.setValue(authToken, forHTTPHeaderField: "x-snaglet-token") }',
      'view.setValue(false, forKey: "drawsBackground")',
    ]);
  });
  it('moves only flower panels; the full-screen window only ever to the screen frame', () => {
    const frames = (code.match(/^.*\bsetFrame(Origin)?\(.*$/gm) ?? []).map((l) => l.trim());
    for (const line of frames) {
      expect(line).toMatch(
        /^(if panel\.frame != frame \{ )?panel\.setFrame\(frame, display: false\)|^self\?\.window\?\.setFrame\(screen\.frame, display: true\)$/
      );
    }
    expect(code).not.toMatch(/\.union\(|\.insetBy\(dx:\s*-/);
    expect(code).not.toMatch(/setContentSize|setFrameTopLeftPoint|\.contentRect\s*=/);
  });
  it('ignores all mouse events, set once and never changed', () => {
    expect(code).toMatch(/let window = NSWindow\(\s*contentRect: screen\.frame/);
    const onWindow = mouseAssignments.filter((a) => a.receiver === 'window');
    expect(onWindow).toEqual([{ receiver: 'window', value: 'true' }]);
  });
  it('never accepts mouse events: only flower panels are ever set to take them', () => {
    for (const a of mouseAssignments) {
      expect(['window', 'panel']).toContain(a.receiver);
      if (a.receiver === 'window') expect(a.value).toBe('true');
    }
    expect(code).not.toMatch(/window\??\.ignoresMouseEvents\s*=\s*false/);
  });
  it('has no web-to-native bridge', () => {
    expect(code).not.toContain('WKScriptMessageHandler');
    expect(code).not.toContain('addScriptMessageHandler');
  });
  it('sends the kill-switch token from the environment, never argv, and logs failures', () => {
    expect(code).toContain('environment["SNAGLET_AUTH_TOKEN"]');
    expect(code).toContain('forHTTPHeaderField: "x-snaglet-token"');
    expect(code).not.toMatch(/arguments\[[^\]]*\][^\n]*[Tt]oken/);
    expect(code).toMatch(/logStderr\("stop request/);
  });
  it('hands the page the session token at document start so its heartbeat authenticates', () => {
    expect(code).toContain('window.__SNAGLET_DESKTOP__');
    expect(code).toContain('injectionTime: .atDocumentStart');
    expect(code).toMatch(/if !authToken\.isEmpty \{[\s\S]*addUserScript/);
  });
  it('sits below the Dock and menu bar, not at status-bar level, and so does every panel', () => {
    expect(code).toContain('window.level = .floating');
    expect(code).toContain('panel.level = .floating');
    for (const m of code.matchAll(/\.level\s*=\s*([.\w]+)/g)) expect(m[1]).toBe('.floating');
    expect(code).not.toMatch(/\.statusBar\b(?!Item)/);
  });
  it('quits by itself when the page stays not ready, after a launch grace', () => {
    expect(code).toMatch(/selfExpiryTicks\s*=\s*30/);
    expect(code).toMatch(/launchGraceSeconds[^=]*=\s*30/);
    expect(code).toContain('exit(0)');
  });
  it('is not a panel, and no window ever becomes key or main or activates the app', () => {
    // NSPanel appears once: as the superclass of the small flower panel.
    expect(code.match(/\bNSPanel\b/g)).toEqual(['NSPanel']);
    expect(code).toMatch(/final class FlowerPanel: NSPanel \{/);
    expect(code).not.toMatch(/canBecomeKey\s*:\s*Bool\s*\{\s*(return\s+)?true/);
    expect(code).not.toMatch(/canBecomeMain\s*:\s*Bool\s*\{\s*(return\s+)?true/);
    expect(code).not.toMatch(/makeKey|makeMain|\bactivate\(|ignoringOtherApps/);
    expect(code).toContain('app.setActivationPolicy(.accessory)');
  });
});

describe('cursor overlay safety: flower panels', () => {
  it('are never key or main, and non-activating so a click never moves focus', () => {
    const panelClass = block('final class FlowerPanel: NSPanel');
    expect(panelClass).toMatch(/override var canBecomeKey: Bool \{ false \}/);
    expect(panelClass).toMatch(/override var canBecomeMain: Bool \{ false \}/);
    // The style is only ever used to build a flower panel.
    expect(code.match(/nonactivatingPanel/g)).toHaveLength(1);
    expect(code).toMatch(
      /FlowerPanel\(\s*contentRect: NSRect\([^)]*\),\s*styleMask: \[\.borderless, \.nonactivatingPanel\]/
    );
    expect(block('func makeFlowerPanel(')).toContain('panel.hidesOnDeactivate = false');
    // A window's style is fixed where it is built, never changed afterward.
    expect(code).not.toMatch(/styleMask\s*(=|\.insert|\.formUnion|\.remove)/);
  });
  it('are small: never the screen frame, and only for grips up to 120 pt square, at most 8', () => {
    expect(constant('flowerPanelMaxSide')).toBeLessThanOrEqual(120);
    expect(constant('flowerPanelMaxCount')).toBeLessThanOrEqual(8);
    const parse = block('func parseFlowerReport(');
    expect(parse).toMatch(/CGFloat\(w\) <= flowerPanelMaxSide/);
    expect(parse).toMatch(/CGFloat\(h\) <= flowerPanelMaxSide/);
    expect(parse).toMatch(/grips\.count < flowerPanelMaxCount/);
    expect(code).not.toMatch(/FlowerPanel\(\s*contentRect:\s*screen/);
  });
  it('take the mouse only for a grip the page reports as settled (live), in one place', () => {
    expect(block('func parseFlowerReport(')).toMatch(/\(item\["live"\] as\? Bool\) == true/);
    const offs = mouseAssignments.filter((a) => a.value !== 'true');
    expect(offs).toEqual([{ receiver: 'panel', value: 'false' }]);
    const show = block('func showFlowers(');
    expect(show).toContain('panel.ignoresMouseEvents = false');
    expect(show).toMatch(/grips\.compactMap/);
    expect(show).toMatch(/for \(grip, frame\) in placed/);
    // A new panel starts click-through; a released one goes click-through and away.
    expect(block('func makeFlowerPanel(')).toContain('panel.ignoresMouseEvents = true');
    const release = block('func releaseFlowers(');
    expect(release).toContain('panel.ignoresMouseEvents = true');
    expect(release).toContain('panel.orderOut(nil)');
  });
  it('let go before the server posts the agent’s next click', () => {
    const poll = constant('flowerPollSeconds');
    const stale = constant('flowerReadStaleSeconds');
    // A normal read turns a panel off within one poll of the event; a page that stops
    // answering loses every panel within stale + one poll. Both beat the server's handoff.
    expect(poll * 1000 * 2).toBeLessThan(FLOWER_HANDOFF_MS);
    expect((stale + poll) * 1000).toBeLessThan(FLOWER_HANDOFF_MS);
    expect(FLOWER_HANDOFF_MS).toBeLessThan(FLOWER_SETTLE_MS);
    const pollBody = block('func pollFlowers(');
    expect(pollBody).toMatch(/uptime\(\) - lastFlowerRead > flowerReadStaleSeconds/);
    expect(pollBody).toMatch(/alphaValue > 0\.5 else \{\s*releaseFlowers/);
    // A malformed or not-ready reply lets go; a late or out-of-order one is never shown.
    expect(pollBody).toMatch(
      /let report = parseFlowerReport\([\s\S]*?\) else \{\s*self\.releaseFlowers/
    );
    // Order and age come from this program's own request count and monotonic clock, so a
    // wall-clock step or a page reload cannot stall or fool them.
    expect(pollBody).toMatch(/request > self\.lastAppliedRequest/);
    expect(pollBody).toMatch(
      /ProcessInfo\.processInfo\.systemUptime - sentAt <= flowerReadStaleSeconds/
    );
    expect(pollBody).not.toMatch(/timeIntervalSince1970/);
  });
  it('stop taking the mouse the moment a press ends, before the next poll moves them', () => {
    // A dragged panel is left at its old spot until the press ends; it must not catch a
    // click there in the moment before the next poll puts it where the flower now is.
    expect(block('func endPress(')).toMatch(
      /guard pressed else \{ return \}\s*pressed = false\s*if let panel = window as\? FlowerPanel \{\s*panel\.ignoresMouseEvents = true\s*\}\s*forward\?\(kind, agentId\)/
    );
  });
  it('never leave a press dangling: a lost button-up ends it, a removed panel cancels it', () => {
    expect(block('func pollFlowers(')).toMatch(
      /NSEvent\.pressedMouseButtons & 1 == 0 \{\s*view\.endPress\("up"\)/
    );
    expect(block('func releaseFlowers(')).toContain('endPress("cancel")');
  });
  it('stay on the main display, except one being dragged, which keeps its panel as it is', () => {
    const show = block('func showFlowers(');
    expect(show).toContain('.intersection(screen.frame)');
    // A drag onto another display must not drop the panel that got the mouse-down.
    expect(show).toMatch(/\.pressed == true[\s\S]*?return \(grip, panel\.frame\)/);
  });
  it('keep their timers running through menu tracking, and quit if the main thread hangs', () => {
    expect(code).toContain('RunLoop.main.add(ready, forMode: .common)');
    expect(code).toContain('RunLoop.main.add(flowers, forMode: .common)');
    expect(code).not.toContain('Timer.scheduledTimer');
    expect(constant('mainStallSeconds')).toBeLessThanOrEqual(1);
    expect(code).toMatch(
      /DispatchSource\.makeTimerSource\([\s\S]*mainWatch\.stalled\(after: mainStallSeconds\)[\s\S]*_exit\(0\)/
    );
    // Ticks on a clock that never steps back or runs on through sleep, and whenever a
    // panel is shown, not only at the end of a poll.
    const watch = block('final class MainThreadWatch');
    expect(watch).toContain('ProcessInfo.processInfo.systemUptime');
    expect(watch).not.toMatch(/\bDate\(/);
    expect(block('func pollFlowers(')).toContain('mainWatch.tick(panelsUp: !flowerPanels.isEmpty)');
    expect(block('func showFlowers(')).toContain('mainWatch.tick(panelsUp: true)');
  });
  it('forward the mouse to the page as JSON, never as raw text in the script', () => {
    const forward = block('func forwardFlowerInput(');
    expect(forward).toContain('JSONSerialization.data(withJSONObject: input)');
    expect(forward).toContain('window.__snagletCursorFlowerInput(\\(json))');
    expect(code).not.toMatch(/evaluateJavaScript\([^\n]*\\\((agentId|id|kind)\)/);
  });
});
