import {
  externalDatabaseUrl,
  scratchDatabaseName,
} from '../../../../packages/db/runtime/postgres/scratch';

describe('db:scratch helpers', () => {
  it('builds a safe prefixed database name', () => {
    expect(scratchDatabaseName('Phase-9_demo')).toBe('snaglet_scratch_phase_9_demo');
  });

  it.each(['', '-leading', 'space name', 'slash/name', 'semi;colon'])(
    'rejects unsafe name %p',
    (name) => {
      expect(() => scratchDatabaseName(name)).toThrow(/Scratch name/);
    }
  );

  it('enforces the PostgreSQL identifier limit', () => {
    expect(() => scratchDatabaseName('x'.repeat(53))).toThrow(/too long/);
  });

  it('prints an encoded unix-socket PostgreSQL URL', () => {
    const value = externalDatabaseUrl({
      database: 'snaglet_scratch_phase9',
      password: 'slash/space value',
      socketDir: '/tmp/snaglet pg/socket',
      user: 'snaglet',
    });
    const parsed = new URL(value);
    expect(parsed.protocol).toBe('postgresql:');
    expect(parsed.username).toBe('snaglet');
    expect(parsed.password).toBe('slash%2Fspace%20value');
    expect(parsed.pathname).toBe('/snaglet_scratch_phase9');
    expect(parsed.searchParams.get('host')).toBe('/tmp/snaglet pg/socket');
    expect(parsed.searchParams.get('sslmode')).toBe('disable');
  });
});
