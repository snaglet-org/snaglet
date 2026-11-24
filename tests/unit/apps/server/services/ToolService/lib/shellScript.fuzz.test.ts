/**
 * shellScript fuzz: a few hundred thousand random lines built from shell
 * tokens never make the reader or the matcher throw, and each one finishes in
 * bounded time. A seeded generator keeps a failure reproducible.
 */
import { readScript } from '@server/services/ToolService/lib/shellScript';
import { matchDenyCommand } from '@server/services/ToolService/lib/commandDenyRule';

const TOKENS = [
  'rm',
  '-rf',
  '-r',
  '--',
  'x',
  '"',
  "'",
  '\\',
  '$',
  '$(',
  ')',
  '(',
  '`',
  '{',
  '}',
  ',',
  '..',
  ';',
  '&&',
  '||',
  '|',
  '&',
  '\n',
  '\r',
  '<<',
  '<<-',
  '<<<',
  'EOF',
  '>',
  '<',
  '2>&1',
  '*',
  '?',
  '[',
  ']',
  '#',
  '=',
  'X=',
  'sh',
  'bash',
  'zsh',
  '-c',
  'eval',
  'xargs',
  '-I{}',
  'env',
  '-S',
  'sudo',
  'source',
  '.',
  'cat',
  'tee',
  'git',
  'push',
  '--force',
  '$X',
  '${',
  '${X:-',
  '((',
  '$((',
  "$'",
  '@(',
  '!',
  'case',
  'in',
  'esac',
  'alias',
  'PS4=',
  'parallel',
  ':::',
  ' ',
  '\t',
  '~',
  '/bin/',
  'a[',
  '"$@"',
  "'rm -rf x'",
  '"$(rm -rf x)"',
  '<(',
  'find',
  '-exec',
  '{}',
  '\\;',
];
/** Fewer quotes, so more lines get past the reader into the matcher. */
const SOFT = TOKENS.filter((t) => !['"', "'", '\\', '\r', '`', '$(', '(', '<<'].includes(t));

function lines(seed: number, count: number, tokens: readonly string[]): string[] {
  let state = seed;
  const rand = (n: number): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % n;
  };
  const out: string[] = [];
  for (let k = 0; k < count; k++) {
    let line = '';
    for (let n = 1 + rand(24); n > 0; n--)
      line += tokens[rand(tokens.length)]! + (rand(5) < 3 ? ' ' : '');
    out.push(line);
  }
  return out;
}

describe('shellScript fuzz', () => {
  it.each([
    ['every token', 1, TOKENS],
    ['few quotes', 2, SOFT],
  ])('%s: 150,000 random lines, no exception, bounded time', (_label, seed, tokens) => {
    let worst = 0;
    for (const line of lines(seed, 150_000, tokens)) {
      const t0 = performance.now();
      expect(() => readScript(line)).not.toThrow();
      matchDenyCommand('rm -r:*', line);
      matchDenyCommand('git push --force:*', line);
      worst = Math.max(worst, performance.now() - t0);
    }
    expect(worst).toBeLessThan(200);
  });

  it('long random lines near the length cap stay fast', () => {
    for (const line of lines(3, 40, TOKENS).map((l) => l.repeat(Math.ceil(60_000 / l.length)))) {
      const t0 = performance.now();
      matchDenyCommand('rm -r:*', line.slice(0, 64 * 1024));
      expect(performance.now() - t0).toBeLessThan(200);
    }
  });
});
