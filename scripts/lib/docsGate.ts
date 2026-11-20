/**
 * The documentation release gate: pure checks over tracked markdown, so
 * `scripts/lint-docs.ts` stays a thin CLI and `tests/build/docs-gate.test.ts`
 * can prove each rule on small fixtures.
 *
 * Rules:
 * - machine-path: a personal machine path (`/Users/<name>`, `/home/<name>`,
 *   `C:\Users\<name>`) other than an obvious placeholder such as `/Users/you`.
 * - live-id: a Snaglet node id that looks real. Placeholder ids repeat one digit
 *   (`doc-1111111111111-aaaaaaaaa`).
 * - placeholder: TODO, TBD, FIXME or XXX left in prose.
 * - stale-language: plan or history wording (`Phase 2`, `as of 2026`,
 *   `retired in`, template stubs) in the published docs: the root guides and
 *   everything under `docs/`.
 * - broken-link: a relative link or image whose file, or heading anchor, does
 *   not exist.
 * - index: a doc under `docs/` that `docs/INDEX.md` does not link.
 * - plan-doc: any tracked file under `docs/plans/` or `docs/notes/`. Plans,
 *   studies and handoff notes are not kept in the repository.
 * - orphan-asset: a non-markdown file under `docs/` that no markdown links.
 * - pnpm-script: `pnpm <script>` in a doc naming a script no package.json has.
 */
import path from 'node:path';

export type DocsGateRule =
  | 'machine-path'
  | 'live-id'
  | 'placeholder'
  | 'stale-language'
  | 'broken-link'
  | 'index'
  | 'plan-doc'
  | 'orphan-asset'
  | 'pnpm-script';

export interface DocsGateViolation {
  file: string;
  line: number;
  rule: DocsGateRule;
  message: string;
}

export interface DocsGateInput {
  /** Every tracked file, repo-relative with forward slashes. */
  trackedFiles: string[];
  /** Reads a tracked file by repo-relative path. */
  readFile: (file: string) => string;
  /** Script names per package: key '' is the workspace root, others are package names and dirs. */
  scripts: Map<string, Set<string>>;
}

/** Markdown the gate skips: vendored third-party text. */
const EXCLUDED_MARKDOWN = [/^tests\/support\/searchEval\/wikipedia\//];

/**
 * Agent-facing skill and tool text is rendered inside Snaglet, where `[title](id)`
 * links name workspace nodes, not repo files: SKILL.md and TOOL.md, and a
 * file a built-in skill serves beside its SKILL.md (read with the skill
 * tool). Only the link check skips it.
 */
const SNAGLET_RENDERED_MARKDOWN =
  /(?:^|\/)(?:SKILL|TOOL)\.md$|^apps\/server\/builtin-skills\/[^/]+\/[^/]+\.md$/;

const PLACEHOLDER_USERS = new Set([
  'you',
  'yourname',
  'your-name',
  'username',
  'user',
  'me',
  'name',
  'example',
  'runner',
  'shared',
]);

const MACHINE_PATH = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)([^\s/\\`'")\]<>]+)/g;

const LIVE_ID =
  /\b(?:thread|doc|message|memory|table|agent|container|node|image|file|project)-(\d{13})-[a-z0-9]{9}\b/g;

const PLACEHOLDER_WORDS = /\b(?:TODO|TBD|FIXME|XXX)\b/g;

const PUBLISHED_DOCS = /^(?:README|CONTRIBUTING|SECURITY|CODE_OF_CONDUCT)\.md$|^docs\//;

const STALE_LANGUAGE =
  /\b(?:INSERT_HERE|REPLACE_ME|Phase [0-9]|open work|pending decision|as of 20\d\d|retired in)\b|(?<![\w-])phase-[0-9a-z]/gi;

const PNPM_BUILTINS = new Set([
  'add',
  'approve-builds',
  'audit',
  'bin',
  'config',
  'create',
  'deploy',
  'dlx',
  'env',
  'exec',
  'fetch',
  'i',
  'import',
  'init',
  'install',
  'licenses',
  'link',
  'list',
  'ls',
  'outdated',
  'pack',
  'patch',
  'patch-commit',
  'prune',
  'publish',
  'rebuild',
  'remove',
  'rm',
  'root',
  'setup',
  'store',
  'unlink',
  'up',
  'update',
  'why',
]);

function isCheckedMarkdown(file: string): boolean {
  return /\.mdx?$/.test(file) && !EXCLUDED_MARKDOWN.some((pattern) => pattern.test(file));
}

interface ScannedLine {
  text: string;
  line: number;
  inFence: boolean;
  fenceLang: string;
}

export function scanLines(source: string): ScannedLine[] {
  const lines = source.split('\n');
  const out: ScannedLine[] = [];
  let fence: { marker: string; lang: string } | null = null;
  lines.forEach((text, index) => {
    const opener = /^\s{0,3}(`{3,}|~{3,})\s*([\w-]*)/.exec(text);
    if (fence) {
      if (
        opener &&
        opener[1][0] === fence.marker[0] &&
        opener[1].length >= fence.marker.length &&
        !opener[2]
      ) {
        out.push({ text, line: index + 1, inFence: true, fenceLang: fence.lang });
        fence = null;
        return;
      }
      out.push({ text, line: index + 1, inFence: true, fenceLang: fence.lang });
      return;
    }
    if (opener) {
      fence = { marker: opener[1], lang: opener[2].toLowerCase() };
      out.push({ text, line: index + 1, inFence: true, fenceLang: fence.lang });
      return;
    }
    out.push({ text, line: index + 1, inFence: false, fenceLang: '' });
  });
  return out;
}

function stripInlineCode(text: string): string {
  return text.replace(/(`+)[\s\S]*?\1/g, (match) => ' '.repeat(match.length));
}

function inlineCodeSpans(text: string): string[] {
  return [...text.matchAll(/(`+)([\s\S]*?)\1/g)].map((match) => match[2]);
}

/** GitHub-style heading slug. */
export function slugify(heading: string): string {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

export function headingAnchors(source: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const { text, inFence } of scanLines(source)) {
    if (inFence) continue;
    for (const match of text.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchors.add(match[1]);
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(text);
    if (!heading) continue;
    const base = slugify(heading[1]);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return anchors;
}

interface LinkRef {
  target: string;
  line: number;
}

export function relativeLinks(source: string): LinkRef[] {
  const links: LinkRef[] = [];
  for (const { text, line, inFence } of scanLines(source)) {
    if (inFence) continue;
    const prose = stripInlineCode(text);
    for (const match of prose.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      links.push({ target: match[1], line });
    }
    for (const match of prose.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) {
      links.push({ target: match[1], line });
    }
    for (const match of prose.matchAll(/^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/g)) {
      links.push({ target: match[1], line });
    }
  }
  return links;
}

function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');
}

function contentRules(file: string, source: string): DocsGateViolation[] {
  const violations: DocsGateViolation[] = [];
  for (const { text, line, inFence } of scanLines(source)) {
    for (const match of text.matchAll(MACHINE_PATH)) {
      const user = match[1].replace(/[.,;:!?]+$/, '');
      if (PLACEHOLDER_USERS.has(user.toLowerCase()) || /^[<${]/.test(user)) continue;
      violations.push({
        file,
        line,
        rule: 'machine-path',
        message: `personal machine path "${match[0]}"`,
      });
    }
    for (const match of text.matchAll(LIVE_ID)) {
      if (/^(\d)\1+$/.test(match[1])) continue;
      violations.push({
        file,
        line,
        rule: 'live-id',
        message: `real-looking id "${match[0]}"; use a placeholder such as doc-1111111111111-aaaaaaaaa`,
      });
    }
    if (!inFence) {
      const prose = stripInlineCode(text);
      for (const match of prose.matchAll(PLACEHOLDER_WORDS)) {
        violations.push({
          file,
          line,
          rule: 'placeholder',
          message: `unfinished marker "${match[0]}"`,
        });
      }
      if (PUBLISHED_DOCS.test(file)) {
        for (const match of prose.matchAll(STALE_LANGUAGE)) {
          violations.push({
            file,
            line,
            rule: 'stale-language',
            message: `plan or history wording "${match[0]}"; describe current behavior`,
          });
        }
      }
    }
  }
  return violations;
}

function resolveTarget(fromFile: string, target: string): string {
  const withoutQuery = target.split('?')[0];
  if (withoutQuery.startsWith('/')) return path.posix.normalize(withoutQuery.slice(1));
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), withoutQuery));
}

function pnpmCommands(source: string): Array<{ command: string; line: number }> {
  const commands: Array<{ command: string; line: number }> = [];
  for (const { text, line, inFence, fenceLang } of scanLines(source)) {
    const shellFence = ['', 'bash', 'sh', 'shell', 'zsh', 'console', 'powershell', 'ps1'].includes(
      fenceLang
    );
    const chunks = inFence
      ? shellFence && !/^\s{0,3}(`{3,}|~{3,})/.test(text)
        ? [text]
        : []
      : inlineCodeSpans(text);
    for (const chunk of chunks) {
      for (const match of chunk.matchAll(/(?:^|[\s;&|(])pnpm\s+([^;&|`\n]+)/g)) {
        commands.push({ command: match[1].replace(/\s#.*$/, '').trim(), line });
      }
    }
  }
  return commands;
}

/** Returns the script a pnpm command runs and the package scope it runs in, or null for builtins. */
export function parsePnpmCommand(
  command: string
): { script: string; scope: string | null; anyPackage: boolean } | null {
  const tokens = command.split(/\s+/).filter(Boolean);
  let scope: string | null = '';
  let anyPackage = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--filter' || token === '-F') {
      const value = tokens[index + 1] ?? '';
      index += 1;
      if (/[*{]/.test(value) || value.startsWith('...') || value.endsWith('...')) anyPackage = true;
      scope = value
        .replace(/^\.\//, '')
        .replace(/^\{|\}$/g, '')
        .replace(/\/$/, '');
      continue;
    }
    if (token.startsWith('--filter=')) {
      scope = token.slice('--filter='.length);
      if (/[*{]/.test(scope)) anyPackage = true;
      continue;
    }
    if (token === '-C' || token === '--dir') {
      scope = (tokens[index + 1] ?? '').replace(/^\.\//, '').replace(/\/$/, '');
      index += 1;
      continue;
    }
    if (token === '-r' || token === '--recursive') {
      anyPackage = true;
      continue;
    }
    if (token.startsWith('-')) continue;
    if (token === 'run' || token === 'run-script') {
      const script = tokens[index + 1];
      return script && !script.startsWith('-') && !script.startsWith('<')
        ? { script, scope, anyPackage }
        : null;
    }
    if (PNPM_BUILTINS.has(token) || token.startsWith('<') || token.startsWith('$')) return null;
    return { script: token, scope, anyPackage };
  }
  return null;
}

export function runDocsGate(input: DocsGateInput): DocsGateViolation[] {
  const tracked = new Set(input.trackedFiles);
  const trackedDirs = new Set<string>();
  for (const file of input.trackedFiles) {
    let dir = path.posix.dirname(file);
    while (dir !== '.' && !trackedDirs.has(dir)) {
      trackedDirs.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  const markdown = input.trackedFiles.filter(isCheckedMarkdown).sort();
  const sources = new Map(markdown.map((file) => [file, input.readFile(file)]));
  const anchorCache = new Map<string, Set<string>>();
  const anchorsFor = (file: string): Set<string> => {
    let anchors = anchorCache.get(file);
    if (!anchors) {
      anchors = headingAnchors(sources.get(file) ?? input.readFile(file));
      anchorCache.set(file, anchors);
    }
    return anchors;
  };

  const violations: DocsGateViolation[] = [];
  const linkedFiles = new Set<string>();
  const indexLinks = new Set<string>();
  const allScripts = new Set([...input.scripts.values()].flatMap((names) => [...names]));

  for (const [file, source] of sources) {
    violations.push(...contentRules(file, source));

    for (const { target, line } of SNAGLET_RENDERED_MARKDOWN.test(file)
      ? []
      : relativeLinks(source)) {
      if (isExternal(target)) continue;
      const [filePart, anchor] = target.split('#');
      const resolved = filePart ? resolveTarget(file, filePart) : file;
      if (filePart && !tracked.has(resolved) && !trackedDirs.has(resolved)) {
        violations.push({
          file,
          line,
          rule: 'broken-link',
          message: `"${target}" points at a missing file`,
        });
        continue;
      }
      linkedFiles.add(resolved);
      if (file === 'docs/INDEX.md') indexLinks.add(resolved);
      if (
        anchor &&
        /\.mdx?$/.test(resolved) &&
        !anchorsFor(resolved).has(decodeURIComponent(anchor).toLowerCase())
      ) {
        violations.push({
          file,
          line,
          rule: 'broken-link',
          message: `"${target}" names a heading that does not exist`,
        });
      }
    }

    for (const { command, line } of pnpmCommands(source)) {
      const parsed = parsePnpmCommand(command);
      if (!parsed) continue;
      const known = parsed.anyPackage ? allScripts : input.scripts.get(parsed.scope ?? '');
      if (known && !known.has(parsed.script)) {
        const where = parsed.scope ? `package "${parsed.scope}"` : 'the root package.json';
        violations.push({
          file,
          line,
          rule: 'pnpm-script',
          message: `"pnpm ${command}" runs "${parsed.script}", which ${where} does not define`,
        });
      }
    }
  }

  const isPlanDoc = (file: string): boolean => /^docs\/(?:plans|notes)\//.test(file);

  if (tracked.has('docs/INDEX.md')) {
    for (const file of markdown) {
      if (!file.startsWith('docs/') || file === 'docs/INDEX.md' || isPlanDoc(file)) continue;
      if (!indexLinks.has(file)) {
        violations.push({ file, line: 1, rule: 'index', message: 'not linked from docs/INDEX.md' });
      }
    }
  }

  for (const file of input.trackedFiles) {
    if (isPlanDoc(file)) {
      violations.push({
        file,
        line: 1,
        rule: 'plan-doc',
        message: 'plans and notes are not kept in the repository; move it out',
      });
    } else if (file.startsWith('docs/') && !isCheckedMarkdown(file) && !linkedFiles.has(file)) {
      violations.push({
        file,
        line: 1,
        rule: 'orphan-asset',
        message: 'no markdown links this file',
      });
    }
  }

  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
