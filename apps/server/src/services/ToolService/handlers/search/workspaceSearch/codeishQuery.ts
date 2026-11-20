/**
 * codeishQuery — deterministic "is this query about code / repo files?" classifier.
 *
 * NO ML. A pure function of the query string alone. Files leave the shared search
 * pool (they flood every non-code query — ~70% of the corpus), so this heuristic
 * is what decides whether to fire the dedicated FILE LANE (see tool.ts): when it
 * returns true and the caller passed no explicit `kinds`, an ADDITIONAL file-only
 * search runs and its hits merge as a separate, labeled section. A false positive
 * is cheap (an extra labeled file section, never pollution of the shared pool); a
 * false negative just means the agent must ask with `kinds: ['file']`. The trigger
 * therefore leans modestly inclusive over the clearly code-shaped signals below,
 * and conservative on prose-colliding words.
 *
 * Signals (query is code-ish if any matches):
 *   1. Code/config file extension          index.ts, Cargo.toml, config.yaml
 *   2. Path-shaped multi-segment token      apps/server/src, packages/db/tables
 *      (2+ separators AND (an extension OR a known code-root prefix))
 *   3. camelCase / PascalCase (>=2 humps)   getUserById, ContainerTreeService
 *   4. snake_case identifier                resolve_doc_subtype, DEFAULT_SEARCH_KINDS
 *   5. scope-resolution / method form        Foo::bar, std::vector
 *   6. code keyword                          function, const, import/export syntax, ...
 *   7. explicit "I mean code/files" phrase   file, files, code, repo, codebase, source code
 */

/** Extensions that mark a bare token as a code/config file (mission list). */
const CODE_EXTENSIONS = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'json',
  'sql',
  'md',
  'css',
  'scss',
  'py',
  'rs',
  'go',
  'sh',
  'yml',
  'yaml',
  'toml',
] as const;

// 1. A token ending in a code/config extension (index.ts, src/index.ts, Cargo.toml).
//    Also catches the "path WITH extension" case since the extension rides the token.
const EXTENSION_RE = new RegExp(`\\b[\\w-]+\\.(?:${CODE_EXTENSIONS.join('|')})\\b`, 'i');

// 2. A path with 2+ separators (apps/server/src), but only when it's actually
//    path-shaped: either a segment carries a file extension, or the token
//    starts with a known code-root prefix (src/, apps/, packages/, docs/,
//    tests/, ./, ~/, ../). Plain slash-joined word lists collide with ordinary
//    prose ("he/she/they", "rock/paper/scissors", "pass/fail/incomplete") and
//    must not count as paths just because they have 2+ separators.
//    Single-slash-no-extension tokens ("and/or", "24/7", "he/she") are also
//    deliberately excluded: they collide with ordinary prose. Single-slash
//    paths WITH an extension are already caught by EXTENSION_RE.
const CODE_ROOT_PREFIX_RE = /^(?:\.{1,2}\/|~\/|src\/|apps\/|packages\/|docs\/|tests\/)/;
const MULTI_SEGMENT_RE = /[\w.@~-]+\/[\w.@~-]+\/[\w.@~-]+/;
const PATH_HAS_EXTENSION_RE = new RegExp(`\\.(?:${CODE_EXTENSIONS.join('|')})\\b`, 'i');

function hasCodeishPath(text: string): boolean {
  const match = MULTI_SEGMENT_RE.exec(text);
  if (!match) return false;
  const token = match[0];
  return PATH_HAS_EXTENSION_RE.test(token) || CODE_ROOT_PREFIX_RE.test(token);
}

// 3a. camelCase: starts lowercase, then >=2 uppercase humps each with a tail
//     (getUserById). Avoids acronyms.
const CAMEL_CASE_RE = /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+){2,}\b/;
// 3b. PascalCase: leading capitalized word + >=2 more humps (ContainerTreeService).
//     Each hump must carry a lowercase tail, so all-caps acronyms (API, CEO, USA)
//     never match, and 1-hump names (TypeScript, ProjectView) are excluded per the
//     ">=2 humps" rule.
const PASCAL_CASE_RE = /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+){2,}\b/;

// 4. snake_case / SCREAMING_SNAKE — word chars joined by underscore(s). Underscores
//    essentially never appear in natural prose, so 1+ is a strong code signal.
const SNAKE_CASE_RE = /\b[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+\b/;

// 5. Scope-resolution operator (Rust/C++/Ruby): Foo::bar, std::vector.
const SCOPE_RES_RE = /\b\w+::\w+/;

// 6a. Standalone code keywords that rarely appear in ordinary prose on their
//    own. `async` and `await` are deliberately EXCLUDED here — both are
//    common non-code workplace jargon ("await confirmation from the client",
//    "async standup notes"), so alone they are not a reliable code signal; a
//    genuine async/await code query almost always carries a second signal
//    (extension, path, camelCase symbol, etc.) that fires independently.
//    Other prose-heavy tokens (class, interface, return, let, var, new,
//    require, extends, implements) remain intentionally excluded too, to
//    avoid noisy firing on ordinary workspace prose.
const BARE_CODE_KEYWORD_RE = /\b(?:function|const|impl|struct|typedef|enum|typeof|instanceof)\b/;

// 6b. `import` / `export` are strong code keywords but collide with ordinary
//    prose ("import contacts from my phone", "export the quarterly report to
//    the board"). Require actual import/export SYNTAX shape rather than the
//    bare word:
//      import { ... } / import ( ... ) / import '...' / import * ...
//      import ... from '...'   (a QUOTED module specifier, not prose "from X")
//      export { ... }
//      export const|function|default|class|let|var|type|interface ...
const IMPORT_RE = /\bimport\b\s*(?:[{('"*]|.*\bfrom\s*['"])/i;
const EXPORT_RE = /\bexport\b\s*(?:\{|(?:const|function|default|class|let|var|type|interface)\b)/i;

// 7. Explicit "I mean files/code" phrases. `file`/`files`/`code`/`repo(sitory)`/
//    `codebase` are strong in a dev workspace. Bare `source` is deliberately not
//    included (collides with "source of truth", a canonical non-code query here);
//    only `source code` / `source file` count.
const CODE_PHRASE_RE = /\b(?:files?|code|codebase|repos?|repositor(?:y|ies))\b/i;
const SOURCE_CODE_RE = /\bsource\s+(?:code|files?)\b/i;

const CODEISH_MATCHERS: readonly RegExp[] = [
  EXTENSION_RE,
  CAMEL_CASE_RE,
  PASCAL_CASE_RE,
  SNAKE_CASE_RE,
  SCOPE_RES_RE,
  BARE_CODE_KEYWORD_RE,
  IMPORT_RE,
  EXPORT_RE,
  CODE_PHRASE_RE,
  SOURCE_CODE_RE,
];

/**
 * True when the query looks like it is about code or repository files. Pure and
 * deterministic — the only input is the query text.
 */
export function isCodeishQuery(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  return hasCodeishPath(trimmed) || CODEISH_MATCHERS.some((re) => re.test(trimmed));
}
