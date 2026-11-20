import type { CursorSpec } from '@snaglet/shared/cursor';
/**
 * The Playwright layer behind one interface, so the controller (safety, tab
 * ownership, refs, approval, idle shutdown) is testable with a fake.
 */
export type Engine = 'chrome' | 'chromium' | 'webkit';

export interface ElementInfo {
  ref: string;
  role: string;
  name: string;
  tag?: string;
  type?: string;
  autocomplete?: string;
  /** Frame the ref belongs to ('' = main), set by the controller. */
  frame?: string;
  /** id / name / aria attributes joined, used only for secret-field detection. */
  attrs?: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
}

export type Modifier = 'Control' | 'Shift' | 'Alt' | 'Meta';
export type Target = { ref: string; frame?: string } | { x: number; y: number };
export interface RefT {
  ref: string;
  frame?: string;
}
export interface ConsoleEntry {
  level: 'error' | 'warn' | 'log';
  text: string;
}
export interface NetworkEntry {
  method: string;
  url: string;
  status: number;
  failure?: string;
}
export interface FrameInfo {
  index: number;
  name: string;
  url: string;
}

export interface HoldOutcome {
  end: 'done' | 'aborted' | 'closed' | 'dialog';
  /** How long every key was down together. */
  heldMs: number;
}

interface DriverDownload {
  suggestedFilename: string;
  saveAs: (destPath: string) => Promise<void>;
}

export interface DriverPage {
  url(): string;
  title(): Promise<string>;
  goto(url: string): Promise<void>;
  nav(kind: 'back' | 'forward' | 'reload'): Promise<void>;
  close(): Promise<void>;
  isClosed(): boolean;
  bringToFront(): Promise<void>;
  /** Tags interactive elements with refs e1..eN (valid until the next collect). */
  collect(max: number, frame?: string): Promise<{ elements: ElementInfo[]; truncated: boolean }>;
  frames(): FrameInfo[];
  read(o: {
    ref?: string;
    frame?: string;
    max: number;
  }): Promise<{ markdown: string; truncated: boolean }>;
  describeAt(x: number, y: number): Promise<ElementInfo | null>;
  describeFocused(): Promise<ElementInfo | null>;
  click(
    t: Target,
    o: { button: 'left' | 'right' | 'middle'; double: boolean; modifiers: Modifier[] }
  ): Promise<void>;
  hover(t: Target, modifiers: Modifier[]): Promise<void>;
  drag(from: Target, to: Target, modifiers: Modifier[]): Promise<{ strategy: string }>;
  dragPath(
    start: Target | undefined,
    path: Array<{ x: number; y: number }>,
    modifiers: Modifier[]
  ): Promise<void>;
  mouse(a: {
    action: 'down' | 'move' | 'up' | 'wheel';
    x?: number;
    y?: number;
    dx?: number;
    dy?: number;
    steps?: number;
  }): Promise<void>;
  type(t: RefT, text: string, submit: boolean): Promise<void>;
  fill(t: RefT, text: string): Promise<void>;
  clear(t: RefT): Promise<void>;
  setChecked(t: RefT, want: boolean): Promise<'changed' | 'already'>;
  press(key: string): Promise<void>;
  /**
   * Holds `keys` down together for `ms`, then releases them (see keyHold.ts).
   * Ends early when `signal` aborts, the page closes, or a dialog opens.
   */
  holdKeys(keys: string[], ms: number, signal?: AbortSignal): Promise<HoldOutcome>;
  select(t: RefT, option: string): Promise<void>;
  upload(t: RefT, files: string[]): Promise<void>;
  scroll(t: Target | undefined, dx: number, dy: number): Promise<void>;
  wait(o: { selector?: string; text?: string; ms?: number }): Promise<void>;
  screenshot(ref?: RefT): Promise<Buffer>;
  pdf(destPath: string): Promise<void>;
  resize(width: number, height: number, scale?: number): Promise<void>;
  pendingDialog(): { type: string; message: string } | null;
  handleDialog(accept: boolean): Promise<void>;
  installCursor(script: string): Promise<void>;
  /**
   * Moves this agent's flower to the target center (viewport coords) via the page
   * function installed by installCursor. Best effort: never throws, never blocks an action.
   */
  flower(
    t: Target | undefined,
    state: 'move' | 'click' | 'drag' | 'error',
    label?: string,
    theme?: { background: string; text: string; border: string },
    avatar?: PageAvatar
  ): Promise<void>;
  /**
   * Shows an emotion's face on this page's flower for ttlMs, then restores neutral, without
   * moving it ('neutral' clears at once). Best effort: never throws.
   */
  setEmotion(emotion: string, ttlMs: number): Promise<void>;
  onConsole(cb: (e: ConsoleEntry) => void): void;
  onNetwork(cb: (e: NetworkEntry) => void): void;
  onDownload(cb: (d: DriverDownload) => void): void;
  onNavigated(cb: (url: string) => void): void;
  onClosed(cb: () => void): void;
}

/** Avatar data for the in-page flower; `avatar`/`avatarStumped` kept alongside `avatars`. */
export interface PageAvatar {
  avatar?: string;
  avatarStumped?: string;
  avatars?: Partial<Record<'neutral' | 'stumped' | 'thinking' | 'curious', string>>;
  ringColor?: string;
}

export interface DriverContext {
  /** Set when the preferred browser was unavailable and a fallback was used. */
  note?: string;
  newPage(): Promise<DriverPage>;
  /** Opens a blank window if the context has none (user sign-in flow). */
  ensureWindow(): Promise<void>;
  traceStart(): Promise<void>;
  traceStop(destPath: string): Promise<void>;
  close(): Promise<void>;
  onClosed(cb: () => void): void;
}

export interface LaunchOptions {
  /** null = ephemeral isolated context. */
  profileDir: string | null;
  engine: Engine;
  forUser: boolean;
}

export interface BrowserDriver {
  launch(opts: LaunchOptions): Promise<DriverContext>;
}

export interface AgentInfo {
  id: string;
  name: string;
  flower: string;
  color: string;
  /** The agent's avatar spec (saved or default); drawn in web pages with the neutral face. */
  cursorSpec?: CursorSpec;
  /** The agent's project folder (uploads/downloads). */
  cwd?: string;
}
