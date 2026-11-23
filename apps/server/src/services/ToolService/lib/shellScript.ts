/**
 * shellScript: reads a shell line into the simple commands it runs, for
 * command deny rules (commandDenyRule.ts). Pure.
 *
 * One quote-aware pass, no grammar: the text splits into simple commands at
 * `;` `&` `|` `&&` `||` `|&`, new lines and `(` `)` `{` `}`, and each word
 * loses its quotes and escapes, so `\rm`, `'rm'` and `r""m` read as `rm`.
 * Text only known when the line runs (a variable, command output, a glob, a
 * brace pattern) is marked unknown. Within one token budget and to a depth of
 * 3, it also reads the scripts a line hands on: `$(…)`, backticks, `<(…)`,
 * the literal after `sh -c` / `bash -c`, a literal `eval` and a literal `trap`.
 *
 * Whatever it cannot be sure about makes the line unreadable, and a command
 * deny rule refuses an unreadable line. The work is linear in the text by
 * construction: a length cap, one token budget, the depth cap, and a cap on
 * the option words read after a shell, `env` or `xargs`.
 */

const MAX_LENGTH = 64 * 1024;
const MAX_TOKENS = 30_000;
const MAX_DEPTH = 3;
const MAX_OPTIONS = 32;
const MAX_HEREDOCS = 16;
/** Stands for text only known when the line runs. */
const UNKNOWN = '\0';

/** Characters a word reader passes through as they are, read a run at a time. */
const PLAIN_RUN = /[^\s;&|()<>\\'"$`*?[\]{},@!+]+/y;

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'csh', 'tcsh']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'time']);
/** Programs that never run a heredoc as a shell script. */
const HEREDOC_READERS =
  /^(?:cat|tee|python[\d.]*|node|ruby|perl|php|psql|mysql|sqlite3|jq|yq|git|gh|kubectl)$/;
/** Programs for which a shell's name is only a word (`which bash`, `brew install zsh`). */
const NAMES_ONLY = new Set(
  'which type command brew file chsh grep rg pgrep ls cat man echo apt apt-get'.split(' ')
);
/**
 * Variables that make the shell run text later (`PS4` under `set -x`), named
 * as a word, an attached option value (`-vPS4`) or a `${…}` name.
 */
const SPECIAL = /(?:\b|^-[A-Za-z]*)(PS4|BASH_ENV|ENV|PROMPT_COMMAND)\b/;
/**
 * `xargs` options, BSD and GNU, one word each: flags, then at most one option
 * with a value, attached or else the next word (`-0I {}`, `-tI{}`), or GNU's
 * `-e`, `-i` or `-l`, whose value is attached only; or a long one.
 */
const XARGS_OPTION =
  /^-[0oprtx]*(?:([EIJLPRSadns])(.*)|([eil])(.*))?$|^--(?:null|verbose|no-run-if-empty|(replace)(?:=(.*))?)$/s;

/** Why a heredoc inside a substitution is refused; the refusal adds a hint. */
export const HEREDOC_IN_SUBSTITUTION = 'a heredoc is inside `$(…)`, backticks or `<(…)`';

export interface Word {
  /** The word after quote removal; UNKNOWN stands for an expansion. */
  text: string;
  /** Index in `text` of the first and the last text only known at run time, or -1. */
  unknownAt: number;
  unknownEnd: number;
  /** Holds an unquoted expansion, which may split into several words. */
  splits: boolean;
  quoted: boolean;
  /** Its span in the command's `source` (-1 for the words `xargs` adds). */
  from: number;
  to: number;
  /** Already read as a script (`sh -c`), so it is read once. */
  read?: boolean;
}

export interface SimpleCommand {
  words: Word[];
  /** Index of the program word: past assignments, keywords and `builtin`/`command`/`exec`. */
  start: number;
  /** The text it was read from. */
  source: string;
  depth: number;
  /** `xargs`: the program it runs, and whether that has a word of its own. */
  feeds?: { at: number; own: boolean };
}

export type ScriptReading = { commands: SimpleCommand[] } | { unreadable: string };

class Unreadable {
  constructor(readonly reason: string) {}
}
const fail = (reason: string): never => {
  throw new Unreadable(reason);
};

interface Budget {
  tokens: number;
  out: SimpleCommand[];
  /**
   * Some command in the line reads a pipe, a file, a heredoc or a here-string.
   * Kept per line, not per command: a group `{ …; }` or `( … )` shares it.
   */
  fed: boolean;
}

interface Heredoc {
  delim: string;
  strip: boolean;
  quoted: boolean;
  cmd: SimpleCommand;
}

export const lastPart = (text: string): string => text.slice(text.lastIndexOf('/') + 1);

/** The last path part holds text only known at run time (or the word may split). */
export const nameUnknown = (w: Word): boolean =>
  w.splits || (w.unknownAt >= 0 && w.unknownEnd > w.text.lastIndexOf('/'));

export function isAssignment(w: Word): boolean {
  const m = /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/.exec(w.text);
  return m !== null && (w.unknownAt < 0 || m[0].length <= w.unknownAt);
}

function mark(w: Word, at: number): void {
  if (w.unknownAt < 0 || at < w.unknownAt) w.unknownAt = at;
  if (at > w.unknownEnd) w.unknownEnd = at;
}

const oneOf = (c: string | undefined, set: string): boolean => c !== undefined && set.includes(c);

const clip = (text: string): string => (text.length > 60 ? `${text.slice(0, 57)}…` : text);

class Reader {
  i = 0;
  constructor(
    readonly s: string,
    readonly b: Budget,
    /** It reads the text of backticks. */
    readonly ticks = false
  ) {}

  spend(): void {
    if (--this.b.tokens < 0) fail('it is too long to check');
  }

  /** Spaces, tabs and `\` line continuations. */
  blanks(): void {
    for (;;) {
      const c = this.s[this.i];
      if (c === ' ' || c === '\t') this.i++;
      else if (c === '\\' && this.s[this.i + 1] === '\n') this.i += 2;
      else return;
    }
  }

  command(depth: number): SimpleCommand {
    return { words: [], start: 0, source: this.s, depth };
  }

  finish(cmd: SimpleCommand): void {
    if (cmd.words.length === 0) return;
    cmd.start = programIndex(cmd.words);
    this.b.out.push(cmd);
  }

  /**
   * Commands up to the end, or up to the `)` closing a `$(` or `<(` (`sub`).
   * `held`: an outer line still owes a heredoc body, so a new line here
   * would be read differently by different shells.
   */
  list(depth: number, sub: boolean, held: boolean): void {
    if (depth > MAX_DEPTH) fail('it nests scripts more than 3 deep');
    const s = this.s;
    const pending: Heredoc[] = [];
    let parens = 0;
    let cmd = this.command(depth);
    const next = (): void => {
      this.finish(cmd);
      cmd = this.command(depth);
    };
    for (;;) {
      this.blanks();
      const c = s[this.i];
      if (c === undefined || (c === ')' && parens === 0 && sub)) {
        if (c === undefined && sub) fail('a `$(` is left open');
        if (parens > 0) fail('a `(` is left open');
        if (pending.length > 0) fail('a heredoc is left open');
        this.finish(cmd);
        if (c === ')') this.i++;
        return;
      }
      this.spend();
      const owes = held || pending.length > 0;
      if (c === '\n') {
        if (held) fail('a heredoc and a substitution share a line');
        this.i++;
        next();
        this.heredocs(pending, depth);
      } else if (c === '#') {
        // bash 3.2 may read a `)` in the comment as the end of the `$(…)`.
        if (sub) fail('a `#` comment is inside `$(…)` or `<(…)`');
        const nl = s.indexOf('\n', this.i);
        this.i = nl === -1 ? s.length : nl;
      } else if (c === '(' || c === ')') {
        if (c === '(' && s[this.i + 1] === '(') fail('it uses `((…))` arithmetic');
        parens += c === '(' ? 1 : -1;
        if (parens < 0) fail('a `)` has no `(`');
        this.i++;
        next();
      } else if (c === ';' || c === '|' || (c === '&' && s[this.i + 1] !== '>')) {
        const op = /^(?:;;&?|;&|&&|\|\||\|&|[;|&])/.exec(s.slice(this.i, this.i + 3))![0];
        this.i += op.length;
        if (op === '|' || op === '|&') this.b.fed = true;
        next();
      } else if (oneOf(c, '<>&') && s[this.i + 1] !== '(') {
        this.redirect(cmd, pending, depth, owes, sub || this.ticks);
      } else {
        const w = this.word(depth, owes);
        const fd = /^\d+$/.test(w.text) && !w.quoted && oneOf(s[this.i], '<>');
        // Its `pattern)` would read as a closing bracket.
        if (w.text === 'case' && !w.quoted && cmd.words.every((x) => KEYWORDS.has(x.text))) {
          fail('`case` is not read by this check');
        }
        if (!w.quoted && (w.text === '{' || w.text === '}')) next();
        else if (!fd) cmd.words.push(w);
      }
    }
  }

  /** `inSub`: in a substitution, where shells find the end of a heredoc in different ways. */
  redirect(
    cmd: SimpleCommand,
    pending: Heredoc[],
    depth: number,
    owes: boolean,
    inSub: boolean
  ): void {
    const op = /^(?:&>>?|<<<|<<-|<<|<>|<&|>>|>&|>\||[<>])/.exec(
      this.s.slice(this.i, this.i + 3)
    )![0];
    const heredoc = op === '<<' || op === '<<-';
    if (heredoc && inSub) fail(HEREDOC_IN_SUBSTITUTION);
    this.i += op.length;
    this.blanks();
    const target = this.word(depth, owes);
    if (target.from === target.to) fail('a redirection has no target');
    if (heredoc) {
      if (target.unknownAt >= 0) fail('a heredoc delimiter is only known when it runs');
      if (pending.length >= MAX_HEREDOCS) fail('it opens too many heredocs');
      pending.push({ delim: target.text, strip: op === '<<-', quoted: target.quoted, cmd });
    }
    if (op[0] === '<') this.b.fed = true;
  }

  /**
   * The heredoc bodies owed after a new line. A body is data: only programs
   * that never run it as a shell may read it. With an unquoted delimiter its
   * `$(…)` and backticks run, so they are read.
   */
  heredocs(pending: Heredoc[], depth: number): void {
    const s = this.s;
    for (const h of pending.splice(0)) {
      const start = this.i;
      let end = -1;
      while (end === -1) {
        const nl = s.indexOf('\n', this.i);
        const line = s.slice(this.i, nl === -1 ? s.length : nl);
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) end = this.i;
        else if (nl === -1) fail('a heredoc is left open');
        // Under an unquoted delimiter bash joins it to the next line, which
        // may then end the heredoc; refused under any delimiter.
        else if (line.endsWith('\\')) fail('a heredoc line ends with `\\`');
        this.i = nl === -1 ? s.length : nl + 1;
        this.spend();
      }
      // An unknown program is refused later (inspect). No program: the
      // heredoc follows a group, `{ …; } <<EOF`, which every command in it reads.
      const prog = h.cmd.words[h.cmd.start];
      const name = prog ? lastPart(prog.text) : '';
      if (!prog || (!nameUnknown(prog) && !HEREDOC_READERS.test(name.toLowerCase()))) {
        const reader = prog ? `\`${clip(name)}\`` : 'a group of commands';
        fail(`a heredoc is fed to ${reader}, which this check does not read`);
      }
      if (!h.quoted) new Reader(s.slice(start, end), this.b).text(blankWord(), depth, false, null);
    }
  }

  /**
   * One word. Globs and brace patterns are unknown text; a brace pattern
   * (`{a,b}`, `{1..9}`) may also become several words, like `$x`.
   */
  word(depth: number, owes: boolean): Word {
    const s = this.s;
    const w: Word = { ...blankWord(), from: this.i, to: this.i };
    let bracket = -1;
    let brace = -1;
    let list = false;
    for (;;) {
      const c = s[this.i];
      if (oneOf(c, '<>') && s[this.i + 1] === '(' && this.i === w.from) {
        this.i += 2;
        this.spend();
        this.list(depth + 1, true, owes);
        this.unknown(w, false);
      } else if (c === undefined || ' \t\n;&|()<>'.includes(c)) {
        break;
      } else if (c === '\\') {
        const d = s[this.i + 1];
        if (d === undefined) fail('it ends with a `\\`');
        this.i += 2;
        if (d !== '\n') w.text += d;
        w.quoted = true;
      } else if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        if (end === -1) fail('a quote is left open');
        w.text += s.slice(this.i + 1, end);
        w.quoted = true;
        this.i = end + 1;
      } else if (c === '"') {
        this.i++;
        this.text(w, depth, owes, '"');
        w.quoted = true;
      } else if (c === '$') {
        this.dollar(w, depth, owes, false);
      } else if (c === '`') {
        this.backtick(w, depth, false);
      } else if (oneOf(c, '*?@!+') && s[this.i + 1] === '(') {
        fail('it uses an extended glob');
      } else if (((PLAIN_RUN.lastIndex = this.i), PLAIN_RUN.exec(s))) {
        const run = s.slice(this.i, PLAIN_RUN.lastIndex);
        list ||= brace >= 0 && run.includes('..');
        w.text += run;
        this.i = PLAIN_RUN.lastIndex;
      } else {
        if (c === '*' || c === '?') mark(w, w.text.length);
        else if (c === '[') bracket = w.text.length;
        else if (c === '{' && brace < 0) brace = w.text.length;
        else if (c === ',') list ||= brace >= 0;
        if ((c === ']' && bracket >= 0) || (c === '}' && list)) {
          mark(w, c === ']' ? bracket : brace);
          mark(w, w.text.length);
          w.splits ||= c === '}';
        }
        w.text += c;
        this.i++;
      }
    }
    w.to = this.i;
    // `x='a[$(…)]'`: bash runs the subscript when it evaluates x as a number.
    const at = w.text.search(/\w\[/);
    if (at >= 0 && (w.text.includes('$(', at) || w.text.includes('`', at))) {
      fail('an array subscript holds a command');
    }
    return w;
  }

  /** Double-quoted text up to `close`, or a heredoc body to its end (`close` null). */
  text(w: Word, depth: number, owes: boolean, close: '"' | null): void {
    const s = this.s;
    for (;;) {
      const c = s[this.i];
      if (c === undefined) {
        if (close !== null) fail('a quote is left open');
        return;
      }
      if (c === close) {
        this.i++;
        return;
      }
      if (c === '\\' && oneOf(s[this.i + 1], '$`"\\\n')) {
        if (s[this.i + 1] !== '\n') w.text += s[this.i + 1];
        this.i += 2;
      } else if (c === '$') this.dollar(w, depth, owes, true);
      else if (c === '`') this.backtick(w, depth, true, close === '"');
      else {
        const stop = /["\\$`]/g;
        stop.lastIndex = this.i + 1;
        const end = stop.exec(s)?.index ?? s.length;
        w.text += s.slice(this.i, end);
        this.i = end;
      }
    }
  }

  dollar(w: Word, depth: number, owes: boolean, quoted: boolean): void {
    const s = this.s;
    const d = s[this.i + 1];
    if (d === "'" && !quoted) fail("it uses `$'…'` quoting");
    if (d === '"' && !quoted) {
      this.i += 2;
      this.text(w, depth, owes, '"');
      w.quoted = true;
      return;
    }
    if (d === '[' || (d === '(' && s[this.i + 2] === '(')) fail('it uses `$((…))` arithmetic');
    if (d === '(') {
      this.i += 2;
      this.spend();
      this.list(depth + 1, true, owes);
    } else if (d === '{') {
      const end = s.indexOf('}', this.i + 2);
      const body = s.slice(this.i + 2, end);
      // bash 3.2 counts a `)` inside `${…}` toward the end of a `$(`.
      const plain = /^[#!]?(?:[A-Za-z_]\w*|\d+|[@*#?$!-])/.test(body) && !/['"`\\{()]/.test(body);
      if (end === -1 || !plain) fail('it uses a `${…}` form this check does not read');
      special(/^[#!]?(\w*)/.exec(body)![1]!);
      this.i = end + 1;
    } else if (d !== undefined && /[\w@*#?$!-]/.test(d)) {
      this.i += 2;
      if (/[A-Za-z_]/.test(d)) while (/\w/.test(s[this.i] ?? '')) this.i++;
    } else {
      w.text += '$';
      this.i++;
      return;
    }
    // `$$`, `$!`, `$?` and `$#` are digits: split or not, never a flag or a name.
    this.unknown(w, quoted || oneOf(d, '$!?#'));
  }

  /** Backticks; in double quotes (`dq`) bash also turns `\"` into `"`. */
  backtick(w: Word, depth: number, quoted: boolean, dq = false): void {
    const s = this.s;
    let body = '';
    let j = this.i + 1;
    for (; s[j] !== '`'; j++) {
      if (s[j] === undefined) fail('a backtick is left open');
      if (s[j] === '\\' && oneOf(s[j + 1], dq ? '`$\\"' : '`$\\')) j++;
      body += s[j];
    }
    this.i = j + 1;
    this.spend();
    new Reader(body, this.b, true).list(depth + 1, false, false);
    this.unknown(w, quoted);
  }

  unknown(w: Word, quoted: boolean): void {
    mark(w, w.text.length);
    w.text += UNKNOWN;
    if (!quoted) w.splits = true;
  }
}

function blankWord(): Word {
  return { text: '', unknownAt: -1, unknownEnd: -1, splits: false, quoted: false, from: 0, to: 0 };
}

function programIndex(ws: Word[]): number {
  let k = 0;
  while (k < ws.length) {
    const t = ws[k]!.text;
    if (isAssignment(ws[k]!) || KEYWORDS.has(t)) {
      k += t === 'time' && ws[k + 1]?.text === '-p' ? 2 : 1;
    } else if (
      t === 'builtin' ||
      t === 'exec' ||
      // macOS has `/usr/bin/command`, found in any case.
      (lastPart(t).toLowerCase() === 'command' && !/^-\w*[vV]/.test(ws[k + 1]?.text ?? ''))
    ) {
      k++;
      while (ws[k]?.text.startsWith('-')) k++;
    } else return k;
  }
  return k;
}

function read(text: string, depth: number, b: Budget): void {
  new Reader(text, b).list(depth, false, false);
}

/** A word or `${…}` name SPECIAL lists. */
function special(text: string): void {
  const m = SPECIAL.exec(text);
  if (m) fail(`it names \`${m[1]}\`, which changes how the shell runs commands`);
}

/**
 * A shell word: the literal script of `sh -c` / `bash -c` is read; any other
 * shell given `-c`, a shell reading its input, and one with options this
 * check cannot follow are unreadable. sh or bash named as a plain argument
 * (`which bash`) is a word, unless the line feeds input to some command.
 */
function shell(cmd: SimpleCommand, k: number, b: Budget, fed: boolean): void {
  const ws = cmd.words;
  // The file system ignores case: `SH` runs sh.
  const name = lastPart(ws[k]!.text).toLowerCase();
  const known = SHELLS.has(name);
  let j = k + 1;
  for (let n = 0; j < ws.length; j++) {
    const w = ws[j]!;
    const t = w.text;
    if (++n > MAX_OPTIONS) return known ? fail('it gives a shell too many options') : undefined;
    if (w.unknownAt >= 0 || w.splits) {
      if (!known || (!w.splits && w.unknownEnd < t.lastIndexOf('/') && !t.endsWith('/'))) return;
      fail(`\`${name}\` gets a word only known when it runs`);
    }
    if (t === '--version' || t === '--help') return;
    if (t === '--' || t === '-') {
      j += t === '--' ? 1 : 0;
      break;
    }
    if (!/^[-+]/.test(t)) break;
    if (known && /^--(?:rcfile|init-file)/.test(t)) fail(`\`${name}\` reads a start-up file first`);
    if (t.startsWith('--')) continue;
    if (!/^[-+][A-Za-z]+$/.test(t)) {
      if (!known) return;
      fail(`\`${name}\` gets an option this check does not read`);
    }
    if (t[0] === '-' && t.includes('c')) {
      if (name !== 'sh' && name !== 'bash') {
        fail(`\`${clip(name)} -c\` scripts follow rules this check does not read`);
      }
      const script = ws[j + 1];
      if (!script || script.unknownAt >= 0 || script.splits || script.text.startsWith('-')) {
        fail(`the script given to \`${name} -c\` is only known when it runs`);
      }
      if (!script!.read) read(script!.text, cmd.depth + 1, b);
      script!.read = true;
      return;
    }
    if (known && t[0] === '-' && t.includes('s'))
      fail(`\`${name} -s\` runs commands from its input`);
    if (/^[-+][A-Za-z]*[oO]$/.test(t)) j++;
  }
  if (!known) return;
  const file = ws[j];
  if (file && (file.text === '-' || file.text.startsWith('/dev/'))) {
    fail(`\`${name}\` runs commands from its input`);
  }
  // A session of another shell would read later writes with its own syntax.
  if (!file && (k === cmd.start || fed || (name !== 'sh' && name !== 'bash'))) {
    fail(`\`${name}\` with no script runs commands from its input`);
  }
}

/** `env -S` / `--split-string` splits a string into a command. */
function env(ws: Word[], k: number): void {
  for (let j = k + 1; j < ws.length && j <= k + MAX_OPTIONS; j++) {
    const w = ws[j]!;
    if (/^-[A-Za-z]*S|^--sp/.test(w.text)) fail('`env -S` splits text into a command');
    if (w.unknownAt === 0 || w.splits || (w.unknownAt >= 0 && w.text.startsWith('-'))) {
      fail('`env` gets an option or program only known when it runs');
    }
    if (/^-[uC]$|^--(?:unset|chdir)$/.test(w.text)) j++;
    else if (!w.text.startsWith('-') && !isAssignment(w)) return;
  }
}

/**
 * `xargs` runs a program with words from its input: they are added to the
 * command as unknown text, or fill the marker of `-I`, `-J`, `-i` or
 * `--replace`. With no program it runs `echo`. An option it cannot classify
 * (XARGS_OPTION) makes the line unreadable.
 */
function feeds(cmd: SimpleCommand, k: number, b: Budget): void {
  const ws = cmd.words;
  if (cmd.feeds) fail('it runs `xargs` inside `xargs`');
  const cannot = (): never => fail('`xargs` gets options it cannot read');
  let j = k + 1;
  let marker: string | null = null;
  let appends = true;
  for (let n = 0; j < ws.length; j++) {
    const t = ws[j]!.text;
    if (!t.startsWith('-') || t === '-') break;
    if (++n > MAX_OPTIONS || ws[j]!.unknownAt >= 0) cannot();
    if (t === '--') {
      j++;
      break;
    }
    const m = XARGS_OPTION.exec(t) ?? cannot();
    const value = m[1] && !m[2] ? (ws[++j] ?? cannot()) : null;
    if (value && value.unknownAt >= 0) cannot();
    if (m[1] === 'I' || m[1] === 'J') marker = value?.text ?? m[2]!;
    else if (m[3] === 'i' || m[5]) marker = m[4] || m[6] || '{}';
    else continue;
    // The last marker option counts; `-J` adds the input at the end when no word is its marker.
    appends = m[1] === 'J';
  }
  const prog = ws[j];
  if (!prog) return;
  if (marker !== null) {
    for (let n = j; n < ws.length; n++) {
      const w = ws[n]!;
      const at = w.text.indexOf(marker);
      if (at >= 0) {
        mark(w, at);
        mark(w, w.text.lastIndexOf(marker));
      }
    }
  }
  if (nameUnknown(prog)) fail('`xargs` runs a program only known when it runs');
  if (SHELLS.has(lastPart(prog.text).toLowerCase())) shell(cmd, j, b, true);
  let own = false;
  for (let n = j + 1; n < ws.length && !own; n++) {
    const w = ws[n]!;
    own = w.unknownAt < 0 && !w.text.startsWith('-') && !isAssignment(w);
  }
  if (appends) {
    ws.push({ ...blankWord(), text: UNKNOWN, unknownAt: 0, unknownEnd: 0, splits: true, from: -1 });
  }
  cmd.feeds = { at: j, own };
}

/** The checks every command deny rule shares; nested scripts are read here. */
function inspect(cmd: SimpleCommand, b: Budget): void {
  const ws = cmd.words;
  const prog = ws[cmd.start];
  let program = '';
  if (prog) {
    if (nameUnknown(prog)) {
      const shown = clip(cmd.source.slice(prog.from, prog.to));
      fail(`its program \`${shown}\` is only known when it runs`);
    }
    const name = lastPart(prog.text);
    program = name;
    const args = ws.slice(cmd.start + 1);
    const first = args[0]?.text === '--' ? args[1] : args[0];
    if (name === 'eval') {
      if (args.some((w) => w.unknownAt >= 0)) fail('`eval` runs text only known when it runs');
      read(args.map((w) => w.text).join(' '), cmd.depth + 1, b);
    } else if (name === 'source' || name === '.') {
      // A file like a script run by name, unless the line may feed it input.
      const input = /^-|^\/dev\/|(?:^|\/)(?:stdin|\d+)$/;
      if (!first || nameUnknown(first) || b.fed || input.test(first.text)) {
        fail(`\`${name}\` runs a file this check does not read`);
      }
    } else if (name === 'trap') {
      if (first && (first.unknownAt >= 0 || first.splits)) {
        fail('`trap` runs text only known when it runs');
      }
      // After `--` the next word is the action, even one that starts with `-`.
      if (first && (first !== args[0] || !first.text.startsWith('-'))) {
        read(first.text, cmd.depth + 1, b);
      }
    } else if (name === 'alias') {
      fail('`alias` is not read by this check');
    } else if (name === 'hash' && args.some((w) => /^-\w*p/.test(w.text))) {
      fail('`hash -p` gives a program another name');
    }
  }
  for (let k = 0; k < ws.length; k++) {
    const w = ws[k]!;
    special(w.text);
    if (/^-(?:exec|execdir|ok|okdir)$/.test(w.text) && ws[k + 1]?.text.includes('{}')) {
      fail('find runs a program only known when it runs');
    }
    if (nameUnknown(w)) continue;
    // The file system ignores case: `RM`, `Xargs` and `SH` run rm, xargs and sh.
    const name = lastPart(w.text).toLowerCase();
    // The program as written: another case may run something else (`/usr/bin/command`).
    const word = NAMES_ONLY.has(program) && !(program === 'brew' && k === cmd.start + 1);
    if (SHELLS.has(name) || /^[a-z]*sh$/.test(name)) {
      if (!word) shell(cmd, k, b, b.fed);
    } else if (name === 'env') env(ws, k);
    else if (name === 'xargs') feeds(cmd, k, b);
    // It hands its command and input to a shell.
    else if (name === 'parallel') fail('`parallel` is not read by this check');
  }
}

/**
 * Read `text` into its simple commands, nested scripts included, or say why
 * it cannot be read. `inspect: false` only splits it (for reading a rule).
 */
export function readScript(text: string, inspectIt = true): ScriptReading {
  if (text.length > MAX_LENGTH) return { unreadable: 'it is longer than 64 KB' };
  // bash keeps a carriage return in a word or a heredoc line.
  if (text.includes('\r')) return { unreadable: 'it holds a carriage return' };
  // bash drops NUL bytes from a script: `r\0m` runs rm.
  if (text.includes('\0')) return { unreadable: 'it holds a NUL byte' };
  const b: Budget = { tokens: MAX_TOKENS, out: [], fed: false };
  try {
    read(text, 0, b);
    for (let k = 0; inspectIt && k < b.out.length; k++) inspect(b.out[k]!, b);
    return { commands: b.out };
  } catch (e) {
    if (e instanceof Unreadable) return { unreadable: e.reason };
    throw e;
  }
}
