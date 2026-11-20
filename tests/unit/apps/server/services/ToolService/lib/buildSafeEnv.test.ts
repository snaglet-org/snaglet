/**
 * buildSafeEnv — allow-list enforcement for untrusted tool/hook child envs.
 *
 * `buildToolEnv`'s `extra` bag is filtered against an explicit allow-list
 * (TOOL_ENV_EXTRA_ALLOWLIST), so SNAGLET_PANEL_TOKEN (full panel/act_as/
 * execute-test authority) can never reach an untrusted tool/hook child even
 * if a careless call site tries to pass it. `buildShellEnv` is a broader,
 * user-authorized trust level and merges `extra` verbatim.
 */
import {
  buildToolEnv,
  buildShellEnv,
  buildAgentGitIdentityEnv,
  buildCommandEnv,
} from '@server/services/ToolService/lib/buildSafeEnv';

describe('buildToolEnv', () => {
  it('never lets SNAGLET_PANEL_TOKEN through, even when explicitly passed as extra', () => {
    const env = buildToolEnv({ SNAGLET_PANEL_TOKEN: 'super-secret-panel-authority' });
    expect(env.SNAGLET_PANEL_TOKEN).toBeUndefined();
  });

  it('passes through allow-listed extras untouched', () => {
    const env = buildToolEnv({
      SNAGLET_SERVER_URL: 'http://127.0.0.1:4001',
      SNAGLET_TOOL_NAME: 'my_tool',
      SNAGLET_HOOK_NAME: 'my_hook',
      SNAGLET_TOOL_CONTEXT_JSON: '{"agentId":"a1"}',
      SNAGLET_CHILD_DISPATCH_TOKEN: 'narrow-token-value',
    });
    expect(env.SNAGLET_SERVER_URL).toBe('http://127.0.0.1:4001');
    expect(env.SNAGLET_TOOL_NAME).toBe('my_tool');
    expect(env.SNAGLET_HOOK_NAME).toBe('my_hook');
    expect(env.SNAGLET_TOOL_CONTEXT_JSON).toBe('{"agentId":"a1"}');
    expect(env.SNAGLET_CHILD_DISPATCH_TOKEN).toBe('narrow-token-value');
  });

  it('silently drops any extra key outside the allow-list (deny by default)', () => {
    const env = buildToolEnv({
      SNAGLET_SERVER_URL: 'http://127.0.0.1:4001',
      SOME_RANDOM_SECRET: 'should-not-appear',
      CREDENTIAL_ENCRYPTION_KEY: 'db-secret',
    });
    expect(env.SNAGLET_SERVER_URL).toBe('http://127.0.0.1:4001');
    expect(env.SOME_RANDOM_SECRET).toBeUndefined();
    expect(env.CREDENTIAL_ENCRYPTION_KEY).toBeUndefined();
  });

  it('still passes through the base allow-listed process env keys (PATH, HOME, etc)', () => {
    const env = buildToolEnv();
    // PATH/HOME are near-universally set in any real process env; assert the
    // pass-through mechanism works without over-asserting on exact values.
    if (process.env.PATH !== undefined) expect(env.PATH).toBe(process.env.PATH);
    if (process.env.HOME !== undefined) expect(env.HOME).toBe(process.env.HOME);
  });

  it('never includes DB/credential secrets that are not in TOOL_ENV_KEYS regardless of extra', () => {
    const env = buildToolEnv({});
    expect(env.CREDENTIAL_ENCRYPTION_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });
});

describe('buildShellEnv (unaffected — broader, user-authorized trust level)', () => {
  it('still merges extra verbatim (no allow-list filtering)', () => {
    const env = buildShellEnv({ CUSTOM_VAR: 'anything-goes-here' });
    expect(env.CUSTOM_VAR).toBe('anything-goes-here');
  });
});

describe('NODE_ENV: the server mode does not leak into agent shells', () => {
  const original = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  });

  it('buildShellEnv drops an inherited NODE_ENV=production', () => {
    expect(buildShellEnv().NODE_ENV).toBeUndefined();
    expect('NODE_ENV' in buildShellEnv()).toBe(false);
  });

  it('buildShellEnv still honors an explicit NODE_ENV in extra', () => {
    expect(buildShellEnv({ NODE_ENV: 'test' }).NODE_ENV).toBe('test');
  });

  it('buildToolEnv (tool and hook children) keeps NODE_ENV unchanged', () => {
    expect(buildToolEnv().NODE_ENV).toBe('production');
  });

  it('a real shell(op:run) started from a production env sees no NODE_ENV', async () => {
    const { default: shellRun } = await import('@server/services/ToolService/tools/shell/shellRun');
    const out = String(await shellRun({ cmd: 'echo "node_env=${NODE_ENV-unset}"' }, {}));
    expect(out).toContain('node_env=unset');
    expect(out).not.toContain('node_env=production');
  });
});

describe('agent git identity in buildShellEnv', () => {
  const KEYS = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];

  it('adds author and committer for a known agent', () => {
    const env = buildShellEnv({}, { id: 'agent-1', name: 'Test Agent' });
    expect(env.GIT_AUTHOR_NAME).toBe('Test Agent (Snaglet agent)');
    expect(env.GIT_COMMITTER_NAME).toBe('Test Agent (Snaglet agent)');
    expect(env.GIT_AUTHOR_EMAIL).toBe('agent-1@agents.snaglet.invalid');
    expect(env.GIT_COMMITTER_EMAIL).toBe('agent-1@agents.snaglet.invalid');
  });

  it('uses the supplied user email instead of the .invalid fallback', () => {
    const env = buildShellEnv({}, { id: 'agent-1', name: 'Test Agent', email: 'user@example.com' });
    expect(env.GIT_AUTHOR_EMAIL).toBe('user@example.com');
    expect(env.GIT_COMMITTER_EMAIL).toBe('user@example.com');
    expect(env.GIT_AUTHOR_NAME).toBe('Test Agent (Snaglet agent)');
  });

  it('adds nothing without an agent, and never inherits the server identity', () => {
    process.env.GIT_AUTHOR_NAME = 'Server Person';
    try {
      for (const agent of [undefined, null, {}, { id: '', name: 'x' }, { id: '///' }]) {
        const env = buildShellEnv({}, agent);
        for (const key of KEYS) expect(env[key]).toBeUndefined();
      }
    } finally {
      delete process.env.GIT_AUTHOR_NAME;
    }
  });

  it('lets an explicit extra win over the derived identity', () => {
    const env = buildShellEnv({ GIT_AUTHOR_NAME: 'Chosen' }, { id: 'agent-1', name: 'Test Agent' });
    expect(env.GIT_AUTHOR_NAME).toBe('Chosen');
    expect(env.GIT_COMMITTER_NAME).toBe('Test Agent (Snaglet agent)');
  });

  it('does not add the identity to tool/hook child envs', () => {
    const env = buildToolEnv({ GIT_AUTHOR_NAME: 'x' });
    expect(env.GIT_AUTHOR_NAME).toBeUndefined();
  });

  it('sanitizes names: spaces, quotes, newlines, unicode', () => {
    const id = { id: 'agent-1' };
    expect(buildAgentGitIdentityEnv({ ...id, name: '  Test   Agent  ' }).GIT_AUTHOR_NAME).toBe(
      'Test Agent (Snaglet agent)'
    );
    expect(buildAgentGitIdentityEnv({ ...id, name: `Te"st'<A>\`gent` }).GIT_AUTHOR_NAME).toBe(
      'TestAgent (Snaglet agent)'
    );
    const nl = buildAgentGitIdentityEnv({ ...id, name: 'Test\nAgent\r\0\u202e' });
    expect(nl.GIT_AUTHOR_NAME).toBe('Test Agent (Snaglet agent)');
    expect(buildAgentGitIdentityEnv({ ...id, name: 'Zoë 日本' }).GIT_AUTHOR_NAME).toBe(
      'Zoë 日本 (Snaglet agent)'
    );
  });

  it('caps the whole name at 80 characters', () => {
    const name = buildAgentGitIdentityEnv({ id: 'a', name: 'x'.repeat(500) }).GIT_AUTHOR_NAME;
    expect(name.length).toBe(80);
    expect(name.endsWith(' (Snaglet agent)')).toBe(true);
  });

  it('falls back to the id when the name is empty after sanitizing', () => {
    expect(buildAgentGitIdentityEnv({ id: 'agent-1', name: '"\n' }).GIT_AUTHOR_NAME).toBe(
      'agent-1 (Snaglet agent)'
    );
  });

  it('sanitizes the id to [a-z0-9._-] in the email', () => {
    const env = buildAgentGitIdentityEnv({ id: 'Agent 1@evil.com\n<x>', name: 'A' });
    expect(env.GIT_AUTHOR_EMAIL).toMatch(/^[a-z0-9._-]+@agents\.snaglet\.invalid$/);
    expect(env.GIT_AUTHOR_EMAIL.split('@')).toHaveLength(2);
  });

  it('keeps two concurrent agents apart', async () => {
    const [a, b] = await Promise.all(
      [
        { id: 'agent-a', name: 'Agent A' },
        { id: 'agent-b', name: 'Agent B' },
      ].map(async (agent) => {
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        return buildShellEnv({}, agent);
      })
    );
    expect(a.GIT_AUTHOR_NAME).toBe('Agent A (Snaglet agent)');
    expect(b.GIT_AUTHOR_NAME).toBe('Agent B (Snaglet agent)');
    expect(a.GIT_COMMITTER_EMAIL).toBe('agent-a@agents.snaglet.invalid');
    expect(b.GIT_COMMITTER_EMAIL).toBe('agent-b@agents.snaglet.invalid');
  });
});

describe('buildCommandEnv', () => {
  const keys = {
    SNAGLET_AUTH_TOKEN: 'test-auth-token-aaaaaaaa',
    SNAGLET_PANEL_TOKEN: 'test-panel-token-aaaaaaaa',
    GH_TOKEN: 'test-gh-token-aaaaaaaa',
    GITHUB_TOKEN: 'test-github-token-aaaaaaaa',
    OPENAI_API_KEY: 'test-provider-key-aaaaaaaa',
    https_proxy: 'http://proxy.example.com:3128',
    SSL_CERT_DIR: '/tmp/test-certs',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    GIT_ASKPASS: '/usr/local/bin/test-askpass',
    SSH_AUTH_SOCK: '/tmp/test-agent.sock',
  };
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const [key, value] of Object.entries(keys)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('keeps the network, TLS and git transport settings and the shell basics', () => {
    const env = buildCommandEnv();
    expect(env).toMatchObject({
      https_proxy: 'http://proxy.example.com:3128',
      SSL_CERT_DIR: '/tmp/test-certs',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
      GIT_ASKPASS: '/usr/local/bin/test-askpass',
      SSH_AUTH_SOCK: '/tmp/test-agent.sock',
    });
    expect(env.PATH).toBeTruthy();
    expect(env.HOME).toBe(process.env.HOME);
  });

  it('drops the session and panel tokens, provider keys and GitHub tokens', () => {
    const env = buildCommandEnv();
    for (const key of [
      'SNAGLET_AUTH_TOKEN',
      'SNAGLET_PANEL_TOKEN',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'OPENAI_API_KEY',
    ]) {
      expect(env[key]).toBeUndefined();
    }
  });
});
