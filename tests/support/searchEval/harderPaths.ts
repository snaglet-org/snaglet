/** Authored path judgments; independent of traversal/ranking order. */
export const harderFiles = [
  'src/auth/session.ts',
  'src/auth/session.test.ts',
  'src/auth/sessionStore.ts',
  'src/auth/oldSession.ts',
  'src/auth/session_backup.ts',
  'src/auth/sessionAdapter.ts',
  'src/session/archive.ts',
  'src/session-old/index.ts',
  'src/session/notes.ts',
  'src/security/refreshToken.ts',
  'src/security/refresh_token.ts',
  'src/security/refreshTokenCache.ts',
  'src/security/oldRefreshToken.ts',
  'src/security/refresh_token_cache.ts',
  'src/security/old_refresh_token.ts',
  'src/legacy/auth/session.ts',
  'src/billing/session.ts',
] as const;
export const harderQueries = [
  { id: 'exact-path', query: 'src/auth/session.ts', expected: ['src/auth/session.ts'] },
  {
    id: 'path-suffix',
    query: 'auth/session.ts',
    expected: ['src/auth/session.ts', 'src/legacy/auth/session.ts'],
  },
  {
    id: 'basename',
    query: 'session.ts',
    expected: ['src/auth/session.ts', 'src/legacy/auth/session.ts', 'src/billing/session.ts'],
  },
  {
    id: 'stem-v-directory',
    query: 'session',
    expected: ['src/auth/session.ts', 'src/legacy/auth/session.ts', 'src/billing/session.ts'],
  },
  { id: 'camel-exact', query: 'refreshToken', expected: ['src/security/refreshToken.ts'] },
  { id: 'snake-exact', query: 'refresh_token', expected: ['src/security/refresh_token.ts'] },
  {
    id: 'prefix-v-substring',
    query: 'refresh',
    expected: [
      'src/security/refreshToken.ts',
      'src/security/refresh_token.ts',
      'src/security/refreshTokenCache.ts',
      'src/security/refresh_token_cache.ts',
    ],
  },
  {
    id: 'directory',
    query: 'auth',
    expected: [
      'src/auth/session.ts',
      'src/auth/session.test.ts',
      'src/auth/sessionStore.ts',
      'src/auth/oldSession.ts',
      'src/auth/session_backup.ts',
      'src/auth/sessionAdapter.ts',
      'src/legacy/auth/session.ts',
    ],
  },
] as const;
