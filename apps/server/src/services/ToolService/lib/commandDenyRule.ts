/**
 * commandDenyRule: whether a command deny rule such as `shell(rm -r:*)`
 * refuses a shell line. Pure. The line is read by shellScript.ts. A rule
 * `NAME FLAGS… WORDS…:*` matches a simple command when
 *  - some word in it is NAME by its last path part, in any case (the file
 *    system ignores it), so `/bin/rm`, `RM`, `sudo rm`, `xargs rm` and
 *    `find … -exec rm` all count, with no list of wrappers (and so does
 *    `git rm`: any word may be the program);
 *  - every flag of the rule comes after that word, before a bare `--`.
 *    Single-dash flags compare as sets of letters (`-rf`, `-fr`, `-r -f`,
 *    `rm x -rf`); ALIASES adds a few other spellings (`-R`, `--recursive`);
 *  - and the rule's other words come after it, in order.
 * An exact rule (no `:*`) needs the same flags and words and nothing more.
 *
 * Where text only known when the line runs could complete a match, the line
 * is refused as unreadable: such a word after NAME that could be a flag
 * (unless a bare `--` comes first), or one that could be NAME itself with the
 * rule's flags after it (for a rule naming only a program, any such word).
 */

import {
  isAssignment,
  lastPart,
  nameUnknown,
  readScript,
  type ScriptReading,
  type SimpleCommand,
  type Word,
} from './shellScript';

interface Aliases {
  short?: Readonly<Record<string, string>>;
  long: Readonly<Record<string, string>>;
}

/** Other spellings of the same flag, for a few programs that delete or force. */
const ALIASES: Readonly<Record<string, Aliases>> = {
  rm: { short: { R: 'r' }, long: { recursive: 'r', force: 'f' } },
  cp: { short: { R: 'r' }, long: { recursive: 'r', force: 'f' } },
  chmod: { long: { recursive: 'R' } },
  chown: { long: { recursive: 'R' } },
  git: { long: { force: 'f' } },
};

/** Programs that never run what `xargs` adds to them as a command. */
const XARGS_SAFE = new Set('echo wc kill grep cat ls stat du head tail'.split(' '));

const nameOf = (w: Word): string => lastPart(w.text).toLowerCase();

interface Rule {
  name: string;
  exact: boolean;
  short: string[];
  long: string[];
  words: string[];
}

/** What a rule found in a line: the simple command it matched, or why the line cannot be checked. */
export type DenyMatch = { part: string } | { unreadable: string };

const isFlag = (w: Word): boolean => w.unknownAt < 0 && w.text.length > 1 && w.text[0] === '-';

/**
 * Unknown text could make the whole word a flag: it may split into several
 * words (`$f`), or nothing known stands before it but a `-` and nothing but
 * letters after it (`"$f"`, `*`, `-?f`; not `"$HOME/x.txt"` or `*.log`).
 */
function mayBeFlag(w: Word): boolean {
  const head = w.text.slice(0, w.unknownAt);
  return (
    w.splits ||
    ((head === '' || head[0] === '-') && /^[\w-]*$/.test(w.text.slice(w.unknownEnd + 1)))
  );
}

/** Letters and long names a flag word carries, other spellings applied (`--rec` is `-r`). */
function flags(text: string, name: string): { short: string[]; long: string | null } {
  const a = ALIASES[name];
  if (!text.startsWith('--')) {
    return { short: [...text.slice(1)].map((c) => a?.short?.[c] ?? c), long: null };
  }
  const long = text.slice(2).split('=')[0]!;
  const full = a && long ? Object.keys(a.long).find((n) => n.startsWith(long)) : undefined;
  return full ? { short: [a!.long[full]!], long: null } : { short: [], long };
}

const rules = new Map<string, Rule | null>();

/** A rule the reader cannot split into plain words (`$`, `;`) is matched only as a prefix. */
function parseRule(spec: string): Rule | null {
  const cached = rules.get(spec);
  if (cached !== undefined) return cached;
  const exact = !spec.endsWith(':*');
  const reading = readScript(exact ? spec : spec.slice(0, -2), false);
  const ws =
    'commands' in reading && reading.commands.length === 1 ? reading.commands[0]!.words : [];
  let rule: Rule | null = null;
  if (ws.length > 0 && ws.every((w) => w.unknownAt < 0 && !w.splits)) {
    const name = nameOf(ws[0]!);
    const short = new Set<string>();
    const long = new Set<string>();
    const words: string[] = [];
    for (const w of ws.slice(1)) {
      if (!isFlag(w)) {
        words.push(w.text);
        continue;
      }
      const f = flags(w.text, name);
      f.short.forEach((c) => short.add(c));
      if (f.long) long.add(f.long);
    }
    rule = { name, exact, short: [...short], long: [...long], words };
  }
  if (rules.size > 256) rules.clear();
  rules.set(spec, rule);
  return rule;
}

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

function shown(cmd: SimpleCommand, w: Word): string {
  return w.from < 0 ? 'what `xargs` adds' : `\`${clip(cmd.source.slice(w.from, w.to), 60)}\``;
}

function part(cmd: SimpleCommand): string {
  const ws = cmd.words.filter((w) => w.from >= 0);
  return clip(cmd.source.slice(ws[0]!.from, ws[ws.length - 1]!.to), 200);
}

/**
 * The rule against one simple command, reading its words right to left so
 * each word is looked at once: at word k, the state holds what the words
 * after it carry.
 */
function matchIn(rule: Rule, cmd: SimpleCommand): DenyMatch | null {
  const ws = cmd.words;
  const m = rule.words.length;
  const short = new Set<string>();
  const long = new Set<string>();
  let extraFlag = false; // a flag the rule does not name (exact rules)
  let anyFlag: Word | null = null; // unknown text that may be any flag, before the nearest `--`
  let anyWord: Word | null = null; // unknown text that may be any word
  let need = m; // rule words not yet found, matched from the end
  let plain = 0; // plain words after k (exact rules)
  let exactWords = true;
  let unsure: DenyMatch | null = null;
  const only = (why: string): DenyMatch => ({ unreadable: why });
  for (let k = ws.length - 1; k >= cmd.start; k--) {
    const w = ws[k]!;
    const flagsOk = rule.short.every((c) => short.has(c)) && rule.long.every((l) => long.has(l));
    if (!nameUnknown(w) && nameOf(w) === rule.name) {
      if (rule.exact) {
        const same = flagsOk && !extraFlag && plain === m && exactWords;
        if (same && !anyWord) return { part: part(cmd) };
        if (anyWord && !extraFlag && plain <= m && exactWords) {
          unsure ??= only(`${shown(cmd, anyWord)} is only known when it runs`);
        }
      } else {
        if (flagsOk && need === 0) return { part: part(cmd) };
        const filler = flagsOk ? anyWord : anyFlag;
        if (filler && (need === 0 || anyWord)) {
          unsure ??= only(
            flagsOk
              ? `${shown(cmd, filler)} is only known when it runs and could be one of the rule's words`
              : `${shown(cmd, filler)} is only known when it runs and could be a flag; words after a bare \`--\` are never flags`
          );
        }
      }
    } else if (
      k > cmd.start &&
      nameUnknown(w) &&
      !isAssignment(w) &&
      w.text[0] !== '-' &&
      flagsOk &&
      need === 0
    ) {
      const after =
        rule.short.length + rule.long.length + m > 0 ? ', with the rest of the rule after it' : '';
      unsure ??= only(
        `${shown(cmd, w)} is only known when it runs and could be \`${rule.name}\`${after}`
      );
    }
    // Fold word k into what the words after k-1 carry.
    if (w.unknownAt < 0 && !w.splits && w.text === '--') {
      extraFlag ||= short.size + long.size > 0;
      short.clear();
      long.clear();
      anyFlag = null;
    } else if (w.unknownAt >= 0 || w.splits) {
      anyWord ??= w;
      if (mayBeFlag(w)) anyFlag ??= w;
    } else if (isFlag(w)) {
      const f = flags(w.text, rule.name);
      for (const c of f.short) {
        short.add(c);
        extraFlag ||= !rule.short.includes(c);
      }
      if (f.long) long.add(f.long);
      extraFlag ||= f.long !== null && !rule.long.includes(f.long);
    } else {
      if (need > 0 && w.text === rule.words[need - 1]) need--;
      plain++;
      exactWords &&= plain <= m && w.text === rule.words[m - plain];
    }
  }
  const feeds = cmd.feeds;
  const prog = feeds ? nameOf(ws[feeds.at]!) : '';
  if (!unsure && feeds && !feeds.own && prog !== rule.name && !XARGS_SAFE.has(prog)) {
    unsure = only(`\`${clip(prog, 60)}\` may run what \`xargs\` adds as a command`);
  }
  return unsure;
}

let last: { line: string; reading: ScriptReading } | null = null;

/**
 * The simple command in `line` that deny rule `specifier` matches, or why
 * the line cannot be checked against it, or null. A line the reader cannot
 * read is refused under any command rule.
 */
export function matchDenyCommand(specifier: string, line: string): DenyMatch | null {
  try {
    if (last?.line !== line) last = { line, reading: readScript(line) };
  } catch {
    last = { line, reading: { unreadable: 'the check could not read it' } };
  }
  const reading = last.reading;
  if ('unreadable' in reading) return reading;
  const rule = parseRule(specifier.trim());
  if (!rule) return null;
  let unsure: DenyMatch | null = null;
  for (const cmd of reading.commands) {
    const hit = matchIn(rule, cmd);
    if (hit && 'part' in hit) return hit;
    unsure ??= hit;
  }
  return unsure;
}
