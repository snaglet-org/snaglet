import { gitRefusal, gitRefusalForStdin } from '@server/services/ToolService/tools/shell/gitSafety';

describe('gitRefusal — destructive or interactive git is refused', () => {
  it.each([
    ['git stash', 'git stash'],
    ['git stash push -m wip', 'git stash'],
    ['git stash pop', 'git stash'],
    ['git reset --hard', 'reset --hard'],
    ['git reset --hard HEAD~1', 'reset --hard'],
    ['git reset --merge', 'reset --hard'],
    ['git clean -f', 'clean -f'],
    ['git clean -fd', 'clean -f'],
    ['git clean -xdf', 'clean -f'],
    ['git clean --force', 'clean -f'],
    ['git checkout -p', 'checkout -p'],
    ['git checkout -- src/a.ts', 'checkout -- <path>'],
    ['git checkout .', 'checkout -- <path>'],
    ['git restore src/a.ts', 'git restore'],
    ['git restore --staged --worktree src/a.ts', 'git restore'],
    ['git restore -p', 'restore -p'],
    ['git add -p', 'add -p'],
    ['git add -i', 'add -p'],
    ['git add --patch src', 'add -p'],
    ['git rebase -i HEAD~3', 'rebase -i'],
    ['git rebase --interactive main', 'rebase -i'],
    ['git commit', 'without `-m`'],
    ['git commit --amend', 'without `-m`'],
    ['git push --force', 'push --force'],
    ['git push -f origin main', 'push --force'],
    ['git push --force-with-lease', 'push --force'],
    ['git push origin +main', 'push --force'],
    ['git branch -D feature', 'branch -D'],
  ])('%s', (cmd, mention) => {
    const refusal = gitRefusal(cmd);
    expect(refusal).not.toBeNull();
    expect(refusal).toMatch(/^Refused: /);
    expect(refusal).toContain(mention);
  });
});

describe('gitRefusal — wrapper and compound forms are still caught', () => {
  it.each([
    'git -C /repo stash',
    'git -c core.pager=cat reset --hard',
    'git --no-pager --git-dir=.git stash',
    '\\git stash',
    '/usr/bin/git stash',
    'GIT_DIR=.git git stash',
    'env GIT_TRACE=1 git reset --hard',
    'sudo git clean -fd',
    'cd repo && git stash',
    'git status; git reset --hard',
    'git diff || git checkout -- .',
    'ls | git stash',
    'echo $(git stash)',
    'echo `git stash`',
    "bash -c 'git stash'",
    'sh -c "cd x && git reset --hard"',
    'zsh -lc "git clean -f"',
    '(git stash)',
    'true\ngit stash',
  ])('%s', (cmd) => {
    expect(gitRefusal(cmd)).toMatch(/^Refused: /);
  });
});

describe('gitRefusal — near-misses still run', () => {
  it.each([
    'git status',
    'git status --short',
    'git diff',
    'git diff --cached --name-only',
    'git log --oneline -5',
    'git show HEAD',
    'git blame src/a.ts',
    'git stash list',
    'git stash show -p stash@{0}',
    'git reset',
    'git reset HEAD src/a.ts',
    'git reset --soft HEAD~1',
    'git restore --staged src/a.ts',
    'git checkout main',
    'git checkout -b feature',
    'git clean -n',
    'git clean -nd',
    'git add src/a.ts',
    'git add -A',
    'git commit -m "msg"',
    'git commit -am "msg"',
    'git commit -F msg.txt',
    'git commit --amend --no-edit',
    'git rebase main',
    'git push',
    'git push origin feature',
    'git branch -d feature',
    'git grep stash',
    'git log --grep "reset --hard"',
    'echo "git stash is refused"',
    "grep -rn 'git reset --hard' docs",
    'ls -la',
    'pnpm test --testPathPatterns gitSafety',
    'gitk',
    '',
  ])('%s', (cmd) => {
    expect(gitRefusal(cmd)).toBeNull();
  });
});

describe('gitRefusal — more matrix cases', () => {
  it.each([
    'git switch --discard-changes main',
    'git switch -f main',
    'git switch --force main',
    'git checkout -f main',
    'git checkout --force main',
    'git clean -fd',
    'git clean -fdx',
    'git clean -xf',
    'git clean -dxf',
    'git clean -d -x -f',
    'git push origin +main',
    'git push origin +HEAD:main',
    'git push -f origin main',
    'git push --force --force-if-includes',
    'git push --force-with-lease --force-if-includes',
    'git -C dir stash',
    "bash -lc 'git stash'",
    'cd x && git stash',
    'git commit --fixup=amend:abc123',
    'git commit --fixup reword:abc123',
  ])('refuses %s', (cmd) => {
    expect(gitRefusal(cmd)).toMatch(/^Refused: /);
  });

  it.each([
    'git commit --no-edit',
    'git commit --amend --no-edit',
    'git commit --fixup abc123',
    'git commit --fixup=abc123',
    'git commit -C abc123',
    'git rebase origin/main',
    'git rebase --onto main a b',
    'git rebase -Xtheirs main',
    'git stash list',
    'git stash show -p stash@{0}',
    'git push --force-if-includes',
    'git switch main',
    'git switch -c feature',
    'git checkout main',
    'git reset --soft HEAD~1',
    'git clean -n',
    'git clean -nd',
  ])('allows %s', (cmd) => {
    expect(gitRefusal(cmd)).toBeNull();
  });
});

describe('gitRefusalForStdin — shell(op:write) line by line', () => {
  it.each(['git reset --hard\n', 'ls\ngit stash\n', 'echo hi\r\ngit clean -fd\r\n', 'git push -f'])(
    'refuses %j',
    (chars) => {
      expect(gitRefusalForStdin(chars)).toMatch(/^Refused: /);
    }
  );

  it.each(['', '\n', 'git status\n', 'y\n', 'print("git stash")\n'])('allows %j', (chars) => {
    expect(gitRefusalForStdin(chars)).toBeNull();
  });
});
