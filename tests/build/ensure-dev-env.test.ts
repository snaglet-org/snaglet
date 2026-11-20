import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ensureDevEnvironment, upsertEnvValue } from '../../scripts/ensure-dev-env';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY = 'CREDENTIAL_ENCRYPTION_KEY';
const VALID_KEY = '0123456789abcdef'.repeat(4);
const HEX_64 = /^[0-9a-f]{64}$/;

interface Fixture {
  repoRoot: string;
  userHome: string;
  cleanup: () => void;
}

/** A scratch checkout (with the real `.env.example`) and a scratch user home. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'snaglet-ensure-dev-env-'));
  const repoRoot = join(root, 'repo');
  const userHome = join(root, 'home');
  mkdirSync(repoRoot);
  mkdirSync(userHome);
  writeFileSync(join(repoRoot, '.env.example'), readFileSync(join(REPO_ROOT, '.env.example')));
  return { repoRoot, userHome, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function run(f: Fixture, env: NodeJS.ProcessEnv = {}) {
  return ensureDevEnvironment({ repoRoot: f.repoRoot, userHome: f.userHome, env, log: () => {} });
}

function readEnv(f: Fixture, name = '.env'): string {
  return readFileSync(join(f.repoRoot, name), 'utf8');
}

function keyIn(content: string): string | undefined {
  return /^CREDENTIAL_ENCRYPTION_KEY=(.*)$/m.exec(content)?.[1];
}

function createCluster(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'PG_VERSION'), '17\n');
}

test('fresh clone: creates .env from the example and fills only the key line', () => {
  const f = fixture();
  try {
    const result = run(f);
    assert.deepEqual(result.actions, ['created-env-file', 'generated-key']);
    assert.equal(result.keyFile, join(f.repoRoot, '.env'));
    assert.equal(result.snagletHome, join(f.userHome, '.snaglet-dev'));
    assert.equal(result.dataDir, join(f.userHome, '.snaglet-dev', 'postgres'));

    const written = readEnv(f);
    assert.match(keyIn(written) ?? '', HEX_64);
    const strip = (s: string) => s.replace(/^CREDENTIAL_ENCRYPTION_KEY=.*$/m, `${KEY}=`);
    assert.equal(strip(written), readEnv(f, '.env.example'), 'every other byte is preserved');
  } finally {
    f.cleanup();
  }
});

test('idempotent: a second run changes nothing and keeps the same key', () => {
  const f = fixture();
  try {
    run(f);
    const first = readEnv(f);
    const result = run(f);
    assert.deepEqual(result.actions, []);
    assert.equal(result.keyFile, null);
    assert.equal(readEnv(f), first);
  } finally {
    f.cleanup();
  }
});

test('existing valid key in .env is never replaced', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repoRoot, '.env'), `${KEY}=${VALID_KEY}\n`);
    const result = run(f);
    assert.deepEqual(result.actions, []);
    assert.equal(readEnv(f), `${KEY}=${VALID_KEY}\n`);
  } finally {
    f.cleanup();
  }
});

test('existing valid key in the process environment is honored without touching files', () => {
  const f = fixture();
  try {
    const result = run(f, { [KEY]: VALID_KEY });
    assert.deepEqual(result.actions, ['created-env-file']);
    assert.equal(keyIn(readEnv(f)), '', 'the example placeholder stays empty');
  } finally {
    f.cleanup();
  }
});

test('malformed key is rejected untrimmed and left untouched', () => {
  // dotenv trims unquoted values, so only a quoted value can carry whitespace
  // through to the runtime regex — and the runtime rejects it untrimmed.
  for (const bad of ['not-hex', VALID_KEY.slice(0, 63), `"${VALID_KEY} "`, `" ${VALID_KEY}"`]) {
    const f = fixture();
    try {
      writeFileSync(join(f.repoRoot, '.env'), `${KEY}=${bad}\n`);
      assert.throws(
        () => run(f),
        /malformed .*Refusing to replace/s,
        `value ${JSON.stringify(bad)}`
      );
      assert.equal(readEnv(f), `${KEY}=${bad}\n`);
    } finally {
      f.cleanup();
    }
  }
});

test('whitespace-only unquoted value is "unset" (dotenv trims it) and gets filled in place', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repoRoot, '.env'), `PORT=4001\n${KEY}= \n`);
    const result = run(f);
    assert.deepEqual(result.actions, ['generated-key']);
    assert.match(readEnv(f), /^PORT=4001\nCREDENTIAL_ENCRYPTION_KEY=[0-9a-f]{64}\n$/);
  } finally {
    f.cleanup();
  }
});

test('malformed key from the process environment is rejected too', () => {
  const f = fixture();
  try {
    assert.throws(() => run(f, { [KEY]: 'nope' }), /from process env is malformed/);
  } finally {
    f.cleanup();
  }
});

test('refuses to generate when the default managed cluster already exists', () => {
  const f = fixture();
  try {
    createCluster(join(f.userHome, '.snaglet-dev', 'postgres'));
    assert.throws(() => run(f), /cluster already exists .*Refusing to generate/s);
    assert.equal(keyIn(readEnv(f)), '', '.env was created but the key stayed empty');
  } finally {
    f.cleanup();
  }
});

test('honors SNAGLET_HOME from the process env and from env files when locating the cluster', () => {
  const viaProcess = fixture();
  try {
    createCluster(join(viaProcess.userHome, 'elsewhere', 'postgres'));
    assert.throws(
      () => run(viaProcess, { SNAGLET_HOME: join(viaProcess.userHome, 'elsewhere') }),
      /cluster already exists/
    );
  } finally {
    viaProcess.cleanup();
  }

  const viaFile = fixture();
  try {
    createCluster(join(viaFile.userHome, 'from-file', 'postgres'));
    writeFileSync(join(viaFile.repoRoot, '.env.dev'), 'SNAGLET_HOME=~/from-file\n');
    assert.throws(() => run(viaFile), /cluster already exists .*from-file/s);
    // No cluster there -> generation proceeds and resolves the same home.
    rmSync(join(viaFile.userHome, 'from-file'), { recursive: true });
    const result = run(viaFile);
    assert.deepEqual(result.actions, ['generated-key']);
    assert.equal(result.snagletHome, join(viaFile.userHome, 'from-file'));
  } finally {
    viaFile.cleanup();
  }
});

test('honors SNAGLET_PG_DATA_DIR over <SNAGLET_HOME>/postgres', () => {
  const f = fixture();
  try {
    const dataDir = join(f.userHome, 'custom-data');
    createCluster(dataDir);
    assert.throws(() => run(f, { SNAGLET_PG_DATA_DIR: dataDir }), /custom-data/);
    // A cluster at the default location is irrelevant when the data dir is redirected.
    rmSync(dataDir, { recursive: true });
    createCluster(join(f.userHome, '.snaglet-dev', 'postgres'));
    const result = run(f, { SNAGLET_PG_DATA_DIR: dataDir });
    assert.deepEqual(result.actions, ['generated-key'], '.env already exists from the failed run');
    assert.equal(result.dataDir, dataDir);
  } finally {
    f.cleanup();
  }
});

test('relative SNAGLET_HOME / SNAGLET_PG_DATA_DIR are rejected like the runtime does', () => {
  const f = fixture();
  try {
    assert.throws(
      () => run(f, { SNAGLET_HOME: 'relative/home' }),
      /SNAGLET_HOME must be an absolute path/
    );
    assert.throws(
      () => run(f, { SNAGLET_PG_DATA_DIR: 'pgdata' }),
      /SNAGLET_PG_DATA_DIR must be an absolute path/
    );
  } finally {
    f.cleanup();
  }
});

test('refuses to generate against an external SNAGLET_DATABASE_URL', () => {
  const f = fixture();
  try {
    assert.throws(
      () => run(f, { SNAGLET_DATABASE_URL: 'postgresql://user:pw@db.example/snaglet' }),
      /external database.*Refusing to generate/s
    );
    writeFileSync(
      join(f.repoRoot, '.env.local'),
      'SNAGLET_DATABASE_URL=postgresql://db.example/snaglet\n'
    );
    assert.throws(() => run(f), /external database/);
    // A key that is already set is fine with an external database.
    const result = run(f, { [KEY]: VALID_KEY });
    assert.deepEqual(result.actions, []);
  } finally {
    f.cleanup();
  }
});

test('present-but-empty key in a higher-precedence file is filled in that file', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repoRoot, '.env.local'), `PORT=4999\n${KEY}=\n`);
    const result = run(f);
    assert.deepEqual(result.actions, ['created-env-file', 'generated-key']);
    assert.equal(result.keyFile, join(f.repoRoot, '.env.local'));
    const local = readEnv(f, '.env.local');
    assert.match(keyIn(local) ?? '', HEX_64);
    assert.match(local, /^PORT=4999\n/, 'other lines untouched');
    assert.equal(keyIn(readEnv(f)), '', '.env placeholder left alone');
  } finally {
    f.cleanup();
  }
});

test('present-but-empty key in the process env does not shadow, and never becomes a file name', () => {
  const f = fixture();
  try {
    // Empty process value + valid file value: runtime sees the file value.
    writeFileSync(join(f.repoRoot, '.env'), `${KEY}=${VALID_KEY}\n`);
    assert.deepEqual(run(f, { [KEY]: '' }).actions, []);
    // Empty process value + nothing in files: generate into .env, not "process env".
    writeFileSync(join(f.repoRoot, '.env'), 'PORT=4001\n');
    const result = run(f, { [KEY]: '' });
    assert.deepEqual(result.actions, ['generated-key']);
    assert.equal(result.keyFile, join(f.repoRoot, '.env'));
    assert.match(readEnv(f), /^PORT=4001\nCREDENTIAL_ENCRYPTION_KEY=[0-9a-f]{64}\n$/);
  } finally {
    f.cleanup();
  }
});

test('helper resolves the key exactly like the runtime loader for SNAGLET_ENV=dev', () => {
  // Drive packages/db's loadSnagletEnvironment in a child process (it mutates
  // process.env and is once-per-process) and compare with the helper's view
  // of the same files, including present-but-empty and $VAR expansion cases.
  const scenarios: Array<{ name: string; files: Record<string, string>; env: NodeJS.ProcessEnv }> =
    [
      {
        name: 'empty in .env.local, valid in .env',
        files: { '.env.local': `${KEY}=\n`, '.env': `${KEY}=${VALID_KEY}\n` },
        env: {},
      },
      {
        name: 'empty in process env, valid in .env.dev',
        files: { '.env.dev': `${KEY}=${VALID_KEY}\n` },
        env: { [KEY]: '' },
      },
      {
        name: 'whitespace in process env shadows files',
        files: { '.env': `${KEY}=${VALID_KEY}\n` },
        env: { [KEY]: ' ' },
      },
      {
        name: 'expanded from another variable',
        files: { '.env': `SEED=${VALID_KEY}\n${KEY}=$SEED\n` },
        env: {},
      },
      {
        name: 'unset everywhere',
        files: { '.env': 'PORT=4001\n' },
        env: {},
      },
    ];

  for (const scenario of scenarios) {
    const f = fixture();
    try {
      for (const [name, content] of Object.entries(scenario.files)) {
        writeFileSync(join(f.repoRoot, name), content);
      }
      const probe = [
        `import { loadSnagletEnvironment } from '@snaglet/db/runtime/snaglet-env';`,
        `loadSnagletEnvironment(${JSON.stringify(f.repoRoot)}, { stopDir: ${JSON.stringify(f.repoRoot)}, log: () => {}, warn: () => {} });`,
        `process.stdout.write(JSON.stringify(process.env[${JSON.stringify(KEY)}] ?? null));`,
      ].join('\n');
      const runtimeValue = JSON.parse(
        execFileSync('npx', ['--silent', 'tsx', '-e', probe], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            SNAGLET_ENV: 'dev',
            ...scenario.env,
          },
        })
      ) as string | null;

      // Mirror the runtime through the helper's observable behavior: a valid
      // effective key -> no-op; an invalid one -> malformed error; none -> generated.
      const before = existsSync(join(f.repoRoot, '.env')) ? readEnv(f) : null;
      let helperView: 'valid' | 'malformed' | 'unset';
      try {
        helperView = run(f, scenario.env).actions.includes('generated-key') ? 'unset' : 'valid';
      } catch (error) {
        assert.match(String(error), /malformed/);
        helperView = 'malformed';
      }
      const runtimeView =
        runtimeValue === null || runtimeValue === ''
          ? 'unset'
          : /^[0-9a-fA-F]{64}$/.test(runtimeValue)
            ? 'valid'
            : 'malformed';
      assert.equal(helperView, runtimeView, scenario.name);
      if (helperView !== 'unset' && before !== null) {
        assert.equal(readEnv(f), before, `${scenario.name}: files untouched`);
      }
    } finally {
      f.cleanup();
    }
  }
});

test('forward references resolve like the runtime, so the cluster guard sees the real home', () => {
  const f = fixture();
  try {
    const customHome = join(f.userHome, 'custom-home');
    createCluster(join(customHome, 'postgres'));
    // SNAGLET_HOME references a variable defined *later* in the same file.
    writeFileSync(join(f.repoRoot, '.env'), `SNAGLET_HOME=$CUSTOM\nCUSTOM=${customHome}\n`);

    const probe = [
      `import { loadSnagletEnvironment } from '@snaglet/db/runtime/snaglet-env';`,
      `loadSnagletEnvironment(${JSON.stringify(f.repoRoot)}, { stopDir: ${JSON.stringify(f.repoRoot)}, log: () => {}, warn: () => {} });`,
      `process.stdout.write(JSON.stringify(process.env.SNAGLET_HOME ?? null));`,
    ].join('\n');
    const runtimeHome = JSON.parse(
      execFileSync('npx', ['--silent', 'tsx', '-e', probe], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME, SNAGLET_ENV: 'dev' },
      })
    ) as string | null;
    assert.equal(runtimeHome, customHome, 'runtime resolves the forward reference');

    assert.throws(() => run(f), /cluster already exists .*custom-home/s);
    assert.equal(keyIn(readEnv(f)), undefined, 'no key was appended');
  } finally {
    f.cleanup();
  }
});

test('upsertEnvValue fills an empty assignment in place or appends', () => {
  assert.equal(upsertEnvValue('A=1\nKEY=\nB=2\n', 'KEY', 'x'), 'A=1\nKEY=x\nB=2\n');
  assert.equal(upsertEnvValue('A=1\n  export KEY =  \n', 'KEY', 'x'), 'A=1\nKEY=x\n');
  assert.equal(upsertEnvValue('A=1\n', 'KEY', 'x'), 'A=1\nKEY=x\n');
  assert.equal(upsertEnvValue('A=1', 'KEY', 'x'), 'A=1\nKEY=x\n');
  assert.equal(upsertEnvValue('', 'KEY', 'x'), 'KEY=x\n');
  // A commented-out or non-empty assignment is not an empty slot.
  assert.equal(upsertEnvValue('# KEY=\nKEY=old\n', 'KEY', 'x'), '# KEY=\nKEY=old\nKEY=x\n');
});
