import assert from 'node:assert/strict';
import test from 'node:test';
import {
  headingAnchors,
  parsePnpmCommand,
  runDocsGate,
  slugify,
  type DocsGateRule,
} from '../../scripts/lib/docsGate';

const ROOT_SCRIPTS = new Map<string, Set<string>>([
  ['', new Set(['dev', 'lint:docs', 'test'])],
  ['apps/server', new Set(['gen:tool-registry'])],
  ['@snaglet/server', new Set(['gen:tool-registry'])],
]);

const INDEX = '# Docs\n\n- [Guide](./guide.md)\n';

function gate(files: Record<string, string>, scripts = ROOT_SCRIPTS) {
  return runDocsGate({
    trackedFiles: Object.keys(files),
    readFile: (file) => files[file],
    scripts,
  });
}

function rules(files: Record<string, string>): DocsGateRule[] {
  return gate(files).map((violation) => violation.rule);
}

test('a clean tree passes', () => {
  assert.deepEqual(
    gate({
      'README.md': '# Snaglet\n\nRun `pnpm dev`. Read the [guide](docs/guide.md#setup).\n',
      'docs/INDEX.md': INDEX,
      'docs/guide.md':
        '# Guide\n\n## Setup\n\nData lives in `~/.snaglet`; see `/Users/you/.snaglet`.\n',
    }),
    []
  );
});

test('machine paths are flagged unless they are placeholders', () => {
  assert.deepEqual(rules({ 'a.md': 'Open /Users/jane/projects/snaglet.\n' }), ['machine-path']);
  assert.deepEqual(rules({ 'a.md': '```sh\ncd /home/sam/snaglet\n```\n' }), ['machine-path']);
  assert.deepEqual(
    rules({ 'a.md': 'Use /Users/you/snaglet, /Users/<user>/snaglet or /Users/Shared.\n' }),
    []
  );
});

test('real-looking ids are flagged, placeholder ids are not', () => {
  assert.deepEqual(rules({ 'a.md': 'See thread-1234567890123-abc123def.\n' }), ['live-id']);
  assert.deepEqual(rules({ 'a.md': 'See `doc-1111111111111-aaaaaaaaa`.\n' }), []);
});

test('unfinished markers are flagged in prose but not in code', () => {
  assert.deepEqual(rules({ 'a.md': 'TODO: explain this.\n' }), ['placeholder']);
  assert.deepEqual(rules({ 'a.md': 'Search for `TODO`.\n\n```ts\n// FIXME\n```\n' }), []);
});

test('published docs may not carry plan or history wording', () => {
  assert.deepEqual(rules({ 'docs/INDEX.md': '# Docs\n\nPhase 2 adds this, as of 2026.\n' }), [
    'stale-language',
    'stale-language',
  ]);
  assert.deepEqual(rules({ 'apps/x/README.md': 'Phase 2 adds this.\n' }), []);
  assert.deepEqual(
    rules({ 'docs/INDEX.md': '# Docs\n\nA two-phase-commit, see `Phase 2`.\n' }),
    []
  );
});

test('broken files and anchors are flagged; links in code and external links are not', () => {
  const files = {
    'docs/a.md': [
      '# A',
      '',
      '## Real heading',
      '',
      '[ok](#real-heading) [ok](./b.md) [ok](https://example.com/x.md)',
      '[missing](./gone.md) [bad anchor](./b.md#nope) ![img](../images/x.png)',
      '`[not a link](./gone.md)`',
      '',
      '```md',
      '[not a link](./gone.md)',
      '```',
    ].join('\n'),
    'docs/b.md': '# B\n',
  };
  const found = gate(files).filter((violation) => violation.rule === 'broken-link');
  assert.deepEqual(
    found.map((violation) => violation.message),
    [
      '"./gone.md" points at a missing file',
      '"./b.md#nope" names a heading that does not exist',
      '"../images/x.png" points at a missing file',
    ]
  );
});

test('agent skill and tool text may use Snaglet node links', () => {
  assert.deepEqual(rules({ 'skills/x/SKILL.md': 'From [<thread>](id).\n' }), []);
  // A file a built-in skill serves beside its SKILL.md is agent-facing too.
  assert.deepEqual(
    rules({ 'apps/server/builtin-skills/x/file-search.md': 'See [Doc](doc-1).\n' }),
    []
  );
  // Nested deeper, or outside the built-in skills, links are still checked.
  assert.deepEqual(rules({ 'apps/server/builtin-skills/x/sub/notes.md': 'See [Doc](doc-1).\n' }), [
    'broken-link',
  ]);
  assert.deepEqual(rules({ 'notes/focus.md': 'See [Doc](doc-1).\n' }), ['broken-link']);
});

test('every doc under docs/ must be in the index', () => {
  assert.deepEqual(
    rules({ 'docs/INDEX.md': INDEX, 'docs/guide.md': '# Guide\n', 'docs/orphan.md': '# Orphan\n' }),
    ['index']
  );
});

test('plans and notes are not tracked', () => {
  assert.deepEqual(
    rules({
      'docs/INDEX.md': '# Docs\n',
      'docs/notes/study.md': '# Note\n\nStatus: draft\n',
      'docs/plans/x.md': '# Plan\n',
      'docs/plans/sketch.png': '',
    }),
    ['plan-doc', 'plan-doc', 'plan-doc']
  );
});

test('assets under docs/ must be linked', () => {
  assert.deepEqual(
    rules({
      'docs/images/used.png': '',
      'docs/images/unused.png': '',
      'README.md': '![x](docs/images/used.png)\n',
    }),
    ['orphan-asset']
  );
});

test('pnpm commands must name a defined script', () => {
  const found = gate({
    'a.md': [
      'Run `pnpm dev`, `pnpm install`, `pnpm run lint:docs` and `pnpm --filter @snaglet/server gen:tool-registry`.',
      'Then `pnpm devv` and `pnpm -C apps/server nope`.',
      '',
      '```bash',
      'pnpm test && pnpm missing',
      '```',
    ].join('\n'),
  });
  assert.deepEqual(
    found.map((violation) => `${violation.line} ${violation.rule}`),
    ['2 pnpm-script', '2 pnpm-script', '5 pnpm-script']
  );
});

test('shell comments after a pnpm command are not part of it', () => {
  assert.deepEqual(rules({ 'a.md': '```bash\npnpm dev   # start the app\n```\n' }), []);
});

test('pnpm command parsing', () => {
  assert.deepEqual(parsePnpmCommand('dev'), { script: 'dev', scope: '', anyPackage: false });
  assert.equal(parsePnpmCommand('install --frozen-lockfile'), null);
  assert.deepEqual(parsePnpmCommand('-r build'), { script: 'build', scope: '', anyPackage: true });
  assert.deepEqual(parsePnpmCommand('--filter @snaglet/ui test'), {
    script: 'test',
    scope: '@snaglet/ui',
    anyPackage: false,
  });
});

test('heading slugs follow GitHub', () => {
  assert.equal(slugify('Environment modes (`SNAGLET_ENV`)'), 'environment-modes-snaglet_env');
  assert.equal(slugify('[Link](x) & more'), 'link--more');
  assert.deepEqual([...headingAnchors('# A\n## A\n<a id="custom"></a>\n')].sort(), [
    'a',
    'a-1',
    'custom',
  ]);
});
