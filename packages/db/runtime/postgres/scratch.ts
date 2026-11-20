const PREFIX = 'snaglet_scratch_';
const MAX_POSTGRES_IDENTIFIER_BYTES = 63;

export function scratchDatabaseName(input: string): string {
  const suffix = input.trim().toLowerCase().replace(/-/g, '_');
  if (!/^[a-z0-9][a-z0-9_]*$/.test(suffix)) {
    throw new Error(
      'Scratch name must start with a letter or digit and contain only letters, digits, underscores, or hyphens.'
    );
  }
  const database = `${PREFIX}${suffix}`;
  if (Buffer.byteLength(database) > MAX_POSTGRES_IDENTIFIER_BYTES) {
    throw new Error(
      `Scratch database name is too long; use at most ${MAX_POSTGRES_IDENTIFIER_BYTES - PREFIX.length} ASCII characters.`
    );
  }
  return database;
}

export function externalDatabaseUrl(options: {
  database: string;
  password: string;
  socketDir: string;
  host?: string;
  port?: number;
  user: string;
}): string {
  const url = new URL('postgresql://localhost');
  url.username = options.user;
  url.password = options.password;
  url.pathname = `/${options.database}`;
  url.searchParams.set('host', options.host ?? options.socketDir);
  if (options.port) url.port = String(options.port);
  url.searchParams.set('sslmode', 'disable');
  return url.toString();
}
