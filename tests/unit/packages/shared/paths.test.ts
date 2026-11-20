import { homedir } from 'node:os';
import * as path from 'node:path';
import { expandHomePath, resolveConfiguredPath } from '@snaglet/shared/utils/paths';

/**
 * The tilde-expansion helper behind Snaglet's path-like settings (SNAGLET_HOME,
 * SNAGLET_PG_DATA_DIR, pointer-file homePath, ...). dotenv delivers
 * `SNAGLET_HOME=~/.snaglet` as a literal string; resolved against the cwd it would
 * create Snaglet homes such as `<repo>/~/.snaglet`, each with its own PostgreSQL
 * cluster.
 */

describe('expandHomePath — plain `~` expansion', () => {
  it('expands a bare `~` to the user home directory', () => {
    expect(expandHomePath('~')).toBe(homedir());
  });

  it('expands `~/...` against the user home directory', () => {
    expect(expandHomePath('~/.snaglet')).toBe(path.join(homedir(), '.snaglet'));
    expect(expandHomePath('~/a/b/c')).toBe(path.join(homedir(), 'a', 'b', 'c'));
  });

  it('leaves absolute paths unchanged', () => {
    expect(expandHomePath('/var/data/snaglet')).toBe('/var/data/snaglet');
  });

  it('leaves bare relative paths unchanged', () => {
    expect(expandHomePath('relative/path')).toBe('relative/path');
  });

  it('leaves `~user/...` literal', () => {
    expect(expandHomePath('~alice/.snaglet')).toBe('~alice/.snaglet');
  });
});

describe('resolveConfiguredPath — strict boundary resolution', () => {
  it('expands SNAGLET_HOME=~/.snaglet to <homedir>/.snaglet', () => {
    expect(resolveConfiguredPath('~/.snaglet', 'SNAGLET_HOME')).toBe(
      path.join(homedir(), '.snaglet')
    );
  });

  it('passes absolute values through unchanged (after trimming)', () => {
    expect(resolveConfiguredPath('  /var/data/snaglet  ', 'SNAGLET_HOME')).toBe(
      '/var/data/snaglet'
    );
  });

  it('rejects a bare relative value instead of resolving against cwd', () => {
    expect(() => resolveConfiguredPath('relative/.snaglet', 'SNAGLET_PG_DATA_DIR')).toThrow(
      /SNAGLET_PG_DATA_DIR must be an absolute path/
    );
  });

  it('rejects an unexpanded `~user/...` value', () => {
    expect(() => resolveConfiguredPath('~alice/.snaglet', 'SNAGLET_HOME')).toThrow(
      /SNAGLET_HOME must be an absolute path/
    );
  });
});
