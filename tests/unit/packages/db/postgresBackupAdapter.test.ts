import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Pool, type PoolConfig } from 'pg';
import type { BinDir } from '@snaglet/db/runtime/postgres/binaries';
import {
  PostgresBackupAdapter,
  type PostgresBackupCommandRunner,
} from '@snaglet/db/adapters/postgres-backup';

interface FakePoolResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
}

class FakeCluster {
  readonly databases = new Set<string>(['postgres', 'snaglet']);
  readonly events: string[] = [];

  reset(): void {
    this.databases.clear();
    this.databases.add('postgres');
    this.databases.add('snaglet');
    this.events.length = 0;
  }

  async query(sql: string, params?: readonly unknown[]): Promise<FakePoolResult> {
    const normalized = sql.replace(/\s+/g, ' ').trim();

    if (normalized.startsWith('SELECT EXISTS (SELECT 1 FROM pg_database')) {
      const database = String(params?.[0] ?? '');
      return { rows: [{ present: this.databases.has(database) }], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT datname FROM pg_database')) {
      const pattern = String(params?.[0] ?? '').replace(/%$/, '');
      const rows = [...this.databases]
        .filter((database) => database.startsWith(pattern))
        .sort()
        .reverse()
        .map((datname) => ({ datname }));
      return { rows, rowCount: rows.length };
    }
    const create = /^CREATE DATABASE "([^"]+)" TEMPLATE template0$/.exec(normalized);
    if (create) {
      this.databases.add(create[1]);
      this.events.push(`create:${create[1]}`);
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith('SELECT pg_terminate_backend')) {
      this.events.push(`terminate:${String(params?.[0] ?? '')}`);
      return { rows: [], rowCount: 0 };
    }
    const rename = /^ALTER DATABASE "([^"]+)" RENAME TO "([^"]+)"$/.exec(normalized);
    if (rename) {
      this.databases.delete(rename[1]);
      this.databases.add(rename[2]);
      this.events.push(`rename:${rename[1]}->${rename[2]}`);
      return { rows: [], rowCount: 0 };
    }
    if (/^ALTER DATABASE "[^"]+" SET hnsw\.ef_search = 100$/.test(normalized)) {
      this.events.push('configure:hnsw.ef_search=100');
      return { rows: [], rowCount: 0 };
    }
    const drop = /^DROP DATABASE "([^"]+)"$/.exec(normalized);
    if (drop) {
      this.databases.delete(drop[1]);
      this.events.push(`drop:${drop[1]}`);
      return { rows: [], rowCount: 0 };
    }
    if (normalized.includes("extname = 'vector'") && normalized.includes("extname = 'pg_trgm'")) {
      return { rows: [{ vector: true, trgm: true }], rowCount: 1 };
    }
    if (normalized.includes("to_regclass('public.nodes')") && normalized.includes('AS ledger')) {
      return {
        rows: [
          {
            nodes: 'nodes',
            messages: 'messages',
            embeddings: 'embeddings',
            ledger: '_migrations',
          },
        ],
        rowCount: 1,
      };
    }
    if (normalized.includes('count(*)::int8 FROM public.nodes')) {
      return {
        rows: [
          {
            nodes: '7',
            messages: '11',
            embeddings: '13',
            migrations: '58',
            hnswEfSearch: '100',
          },
        ],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected fake Pool query: ${normalized}`);
  }
}

const fakeCluster = new FakeCluster();
const poolQuerySpy = jest
  .spyOn(Pool.prototype, 'query')
  .mockImplementation(((sql: string, params?: readonly unknown[]) =>
    fakeCluster.query(sql, params)) as unknown as Pool['query']);
const poolEndSpy = jest.spyOn(Pool.prototype, 'end').mockImplementation(async () => {});

afterAll(() => {
  poolQuerySpy.mockRestore();
  poolEndSpy.mockRestore();
});

interface RecordedCommand {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number | undefined;
}

class FakeBackupCommands {
  readonly commands: RecordedCommand[] = [];
  dumpBytes = Buffer.from('custom backup bytes');
  dumpFailure: { exitCode: number; stderr: string } | undefined;
  dumpOutputPath: string | undefined;

  readonly run: PostgresBackupCommandRunner = async (executable, args, options) => {
    this.commands.push({
      executable,
      args: [...args],
      env: { ...options.env },
      timeoutMs: options.timeoutMs,
    });
    const command = path.basename(executable);
    if (command === 'pg_dump') {
      const outputIndex = args.indexOf('--file');
      this.dumpOutputPath = args[outputIndex + 1];
      if (!this.dumpOutputPath) throw new Error('Fake pg_dump received no --file path');
      if (this.dumpFailure) {
        return {
          exitCode: this.dumpFailure.exitCode,
          signal: null,
          stdout: '',
          stderr: this.dumpFailure.stderr,
        };
      }
      await writeFile(this.dumpOutputPath, this.dumpBytes);
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    }
    if (command === 'pg_restore' || command === 'psql') {
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected fake backup command: ${command}`);
  };
}

function fakeBinDir(rootDir: string): BinDir {
  const binDir = path.join(rootDir, 'bin');
  return {
    rootDir,
    binDir,
    libDir: path.join(rootDir, 'lib'),
    shareDir: path.join(rootDir, 'share'),
    postgres: path.join(binDir, 'postgres'),
    initdb: path.join(binDir, 'initdb'),
    pgCtl: path.join(binDir, 'pg_ctl'),
    pgDump: path.join(binDir, 'pg_dump'),
    pgRestore: path.join(binDir, 'pg_restore'),
    pgConfig: path.join(binDir, 'pg_config'),
    psql: path.join(binDir, 'psql'),
    createdb: path.join(binDir, 'createdb'),
    dropdb: path.join(binDir, 'dropdb'),
  };
}

const CONNECTION: PoolConfig = {
  connectionString: 'postgresql://snaglet:s3cr3t%21@localhost:5432/snaglet',
};

describe('PostgresBackupAdapter', () => {
  let root: string;
  let markerPath: string;
  let binaries: BinDir;
  let commands: FakeBackupCommands;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'snaglet-postgres-backup-unit-'));
    markerPath = path.join(root, 'restore-swap.json');
    binaries = fakeBinDir(path.join(root, 'runtime'));
    commands = new FakeBackupCommands();
    fakeCluster.reset();
    poolQuerySpy.mockClear();
    poolEndSpy.mockClear();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function adapter(
    overrides: {
      quiesce?: () => Promise<void>;
      reconnect?: () => Promise<void>;
      resume?: () => void;
      failSwap?: (error: unknown) => void;
      onSwapState?: (state: 'preparing' | 'parked' | 'promoted') => Promise<void> | void;
    } = {}
  ) {
    return new PostgresBackupAdapter({
      connection: CONNECTION,
      markerPath,
      quiesce: overrides.quiesce ?? (async () => {}),
      reconnect: overrides.reconnect ?? (async () => {}),
      resume: overrides.resume ?? (() => {}),
      failSwap: overrides.failSwap,
      ensureBinaries: async () => binaries,
      runCommand: commands.run,
      onSwapState: overrides.onSwapState,
    });
  }

  it('returns a custom pg_dump artifact with fixed args and keeps credentials out of argv', async () => {
    commands.dumpBytes = Buffer.from([0x50, 0x47, 0x44, 0x4d, 0x50, 0x01]);

    const artifact = await adapter().dump({ format: 'custom' });

    expect(artifact).toEqual(commands.dumpBytes);
    const command = commands.commands[0];
    expect(path.basename(command.executable)).toBe('pg_dump');
    expect(command.args).toEqual(
      expect.arrayContaining([
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        '--file',
        commands.dumpOutputPath,
      ])
    );
    expect(command.args.join(' ')).not.toContain('s3cr3t!');
    expect(command.args.join(' ')).not.toContain('s3cr3t%21');
    expect(command.env.PGPASSWORD).toBe('s3cr3t!');
    expect(command.args.find((argument) => argument.startsWith('--dbname='))).toMatch(
      /^--dbname=postgresql:\/\/snaglet@localhost:5432\/snaglet$/
    );
    expect(commands.dumpOutputPath).toBeDefined();
    await expect(stat(path.dirname(commands.dumpOutputPath!))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('produces a portable gzip stream from a plain SQL dump', async () => {
    commands.dumpBytes = Buffer.from('CREATE TABLE portable(id integer);\n', 'utf8');

    const artifact = await adapter().dump({ format: 'plain-gzip' });

    expect([...artifact.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
    expect(gunzipSync(artifact)).toEqual(commands.dumpBytes);
    expect(commands.commands[0].args).toContain('--format=plain');
    expect(commands.commands[0].args).not.toContain('--format=custom');
  });

  it('surfaces pg_dump failure and removes its temporary directory', async () => {
    commands.dumpFailure = { exitCode: 7, stderr: 'simulated disk full' };

    let thrown: unknown;
    try {
      await adapter().dump();
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/pg_dump .*failed \(exit 7\)/i);
    expect((thrown as Error).message).toContain('simulated disk full');
    expect(commands.dumpOutputPath).toBeDefined();
    await expect(stat(path.dirname(commands.dumpOutputPath!))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(commands.commands).toHaveLength(1);
    expect(commands.commands[0].args.join(' ')).not.toContain('s3cr3t');
  });

  it('rejects legacy embedded artifacts before running commands or opening pools', async () => {
    const backup = adapter();

    await expect(backup.dump({ format: 'legacy-embedded' })).rejects.toThrow(
      /cannot create legacy/i
    );
    await expect(
      backup.restore(Buffer.from('legacy artifact'), { format: 'legacy-embedded' })
    ).rejects.toThrow(/cannot be restored/i);

    expect(commands.commands).toEqual([]);
    expect(poolQuerySpy).not.toHaveBeenCalled();
  });

  it('persists swap states before callbacks and orders quiesce, rename, reconnect, and resume', async () => {
    const states: Array<{ callback: string; marker: string }> = [];
    const backup = adapter({
      quiesce: async () => {
        fakeCluster.events.push('callback:quiesce');
      },
      reconnect: async () => {
        fakeCluster.events.push('callback:reconnect');
      },
      resume: () => {
        fakeCluster.events.push('callback:resume');
      },
      onSwapState: async (state) => {
        const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { state: string };
        states.push({ callback: state, marker: marker.state });
        fakeCluster.events.push(`callback:state:${state}`);
      },
    });

    await backup.restore(Buffer.from('custom artifact'), { format: 'custom' });

    expect(states).toEqual([
      { callback: 'parked', marker: 'parked' },
      { callback: 'promoted', marker: 'promoted' },
    ]);
    const orderedEvents = fakeCluster.events.filter(
      (event) =>
        event.startsWith('callback:') || event.startsWith('rename:') || event.startsWith('drop:')
    );
    expect(orderedEvents).toHaveLength(8);
    expect(orderedEvents[0]).toBe('callback:quiesce');
    expect(orderedEvents[1]).toMatch(/^rename:snaglet->snaglet_parked_/);
    expect(orderedEvents[2]).toBe('callback:state:parked');
    expect(orderedEvents[3]).toMatch(/^rename:snaglet_restore_.*->snaglet$/);
    expect(orderedEvents[4]).toBe('callback:state:promoted');
    expect(orderedEvents[5]).toBe('callback:reconnect');
    expect(orderedEvents[6]).toMatch(/^drop:snaglet_parked_/);
    expect(orderedEvents[7]).toBe('callback:resume');
    expect(fakeCluster.databases).toEqual(new Set(['postgres', 'snaglet']));
    await expect(stat(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(poolEndSpy).toHaveBeenCalledTimes(4);
  });

  it('reports a terminal swap failure when rollback cannot re-quiesce the live pool', async () => {
    const failSwap = jest.fn<(error: unknown) => void>();
    const backup = adapter({
      quiesce: async () => {
        throw new Error('fixture quiesce failure');
      },
      failSwap,
    });

    await expect(
      backup.restore(Buffer.from('custom artifact'), { format: 'custom' })
    ).rejects.toThrow(/automatic rollback also failed/);
    expect(failSwap).toHaveBeenCalledTimes(1);
    expect(failSwap.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect((failSwap.mock.calls[0]?.[0] as Error).message).toMatch(
      /automatic rollback also failed/
    );
    await expect(readFile(markerPath, 'utf8')).resolves.toContain('"state": "preparing"');
  });
});
