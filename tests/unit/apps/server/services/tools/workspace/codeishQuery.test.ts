import { describe, expect, it } from '@jest/globals';
import { isCodeishQuery } from '@server/services/ToolService/handlers/search/workspaceSearch/codeishQuery';

/**
 * The trigger is a pure function; these tables are the contract for when the
 * dedicated file lane fires. A false positive is cheap (an extra labeled file
 * section, never shared-pool pollution), so the heuristic leans inclusive on
 * clearly code-shaped signals and conservative on prose-colliding words.
 */
describe('isCodeishQuery', () => {
  describe('true — code/file-shaped queries', () => {
    const CODEISH: Array<[string, string]> = [
      // File extensions (bare filename and path-with-extension)
      ['bare .ts filename', 'index.ts'],
      ['path with extension', 'src/services/index.ts'],
      ['Cargo.toml', 'Cargo.toml'],
      ['yaml config', 'where is config.yaml'],
      ['sql file', 'schema.sql'],
      ['markdown file', 'update the README.md'],
      ['scss file', 'styles.scss'],
      ['python file', 'run migrate.py'],
      // Multi-segment paths (2+ separators, no extension needed)
      ['dir path', 'apps/server/src'],
      ['deep path', 'packages/db/tables/nodes'],
      // camelCase / PascalCase (>=2 humps)
      ['camelCase symbol', 'getUserById'],
      ['camelCase in prose', 'where do we call resolveDocSubtype'],
      ['PascalCase 3 segments', 'ContainerTreeService'],
      ['PascalCase in prose', 'the ContainerTreeService builder'],
      // snake_case
      ['snake_case', 'resolve_doc_subtype'],
      ['SCREAMING_SNAKE', 'DEFAULT_SEARCH_KINDS'],
      // scope resolution
      ['rust scope res', 'std::vector'],
      ['scope res in prose', 'find Foo::bar'],
      // code keywords
      ['function keyword', 'the function that parses tokens'],
      ['const keyword', 'const declarations'],
      // async keyword alone is intentionally not a signal (see false table);
      // a genuine async code query still fires via another signal (here,
      // the bare `function` keyword).
      ['async code query via function keyword', 'the async function that retries the request'],
      // import/export require actual syntax shape, not just the bare word
      ['import statement (braces + quoted specifier)', "import { Foo } from './bar'"],
      ['import statement (from + quoted specifier)', "import Foo from './bar'"],
      ['export statement (default)', 'export default function toggleFeature()'],
      ['export statement (const)', 'export const DEFAULT_LIMIT = 10'],
      // code-root-prefixed paths (2+ separators and a known code-root prefix)
      ['code-root prefix with extension', 'src/services/tool.ts'],
      ['code-root prefix, deep path with extension', 'apps/server/src/index.ts'],
      // explicit phrases
      ['bare "file"', 'find the file for auth'],
      ['plural files', 'files about the parser'],
      ['code where', 'the code where we handle login'],
      ['in the repo', 'where is this in the repo'],
      ['codebase', 'search the codebase for the reducer'],
      ['repository', 'grep the repository'],
      ['source code', 'source code for the auth flow'],
      ['source files', 'the source files that build the tree'],
    ];
    it.each(CODEISH)('fires for %s', (_label, query) => {
      expect(isCodeishQuery(query)).toBe(true);
    });
  });

  describe('false — ordinary prose / non-code queries', () => {
    const NON_CODEISH: Array<[string, string]> = [
      ['budget decision', 'what did we decide about the budget'],
      ['meeting notes', 'meeting notes from tuesday'],
      ['food preferences', "peach's food preferences"],
      ['travel', 'travel wishlist for next year'],
      ['quarterly plan', 'the plan for next quarter'],
      ['housing tasks', 'housing tasks still open'],
      // "source of truth" is a canonical non-code query in this workspace —
      // bare "source" must not fire the lane.
      ['source of truth', 'docs as the source of truth'],
      // all-caps acronyms are not camelCase symbols
      ['CEO acronym', 'CEO update this week'],
      ['API acronym', 'API design discussion'],
      ['FAQ acronym', 'FAQ for onboarding'],
      // single-slash-no-extension tokens are prose, not paths
      ['and/or', 'and/or logic in the filter'],
      ['24/7', '24/7 support coverage'],
      ['he/she', 'he/she said in the retro'],
      // single-hump PascalCase is below the >=2 hump bar
      ['TypeScript', 'TypeScript migration plan'],
      ['JavaScript', 'JavaScript vs Python tradeoffs'],
      ['ProjectView', 'the ProjectView redesign'],
      // ordinary multi-word prose with no symbol shape
      ['user feedback', 'user feedback from the demo'],
      ['dinner recipe', 'the dinner recipe from last week'],
      ['standup', 'weekly standup summary'],
      ['empty', ''],
      ['whitespace', '   '],
      // `await`/`async` are common non-code workplace jargon — bare, they
      // must not fire the lane (a real code query carries a second signal).
      ['await in prose', 'await confirmation from the client'],
      ['await in prose (short)', 'await her reply'],
      ['async in prose', 'async standup notes'],
      // `export`/`import` in prose without real syntax shape around them
      ['export in prose', 'export the quarterly report to the board'],
      ['import in prose', 'import contacts from my phone'],
      // 2+-slash word lists that are ordinary prose, not paths — no
      // extension and no known code-root prefix on any segment
      ['pronoun list', 'he/she/they pronouns'],
      ['grading policy', 'pass/fail/incomplete grading policy'],
      ['game slogan', 'rock/paper/scissors tournament'],
    ];
    it.each(NON_CODEISH)('does not fire for %s', (_label, query) => {
      expect(isCodeishQuery(query)).toBe(false);
    });
  });
});
