import { normalizeToolAccessConfig } from '@snaglet/shared/types/config';

describe('normalizeToolAccessConfig', () => {
  it('defaults to all mode with empty lists', () => {
    expect(normalizeToolAccessConfig(undefined)).toEqual({
      mode: 'all',
      allowList: [],
      denyList: [],
    });
  });

  it('normalizes canonical fields', () => {
    expect(
      normalizeToolAccessConfig({
        toolAccessMode: 'deny_list',
        toolAllowList: ['file_read'],
        toolDenyList: ['shell_exec'],
      })
    ).toEqual({
      mode: 'deny_list',
      allowList: ['file_read'],
      denyList: ['shell_exec'],
    });
  });

  it('normalizes legacy allowlist mode alias', () => {
    expect(
      normalizeToolAccessConfig({
        toolAccessMode: 'allowlist',
        toolAllowList: ['database_query'],
      })
    ).toEqual({
      mode: 'allow_list',
      allowList: ['database_query'],
      denyList: [],
    });
  });

  it('infers allow_list from legacy tools array when mode is absent', () => {
    expect(normalizeToolAccessConfig({ tools: ['file_read', 'file_write'] })).toEqual({
      mode: 'allow_list',
      allowList: ['file_read', 'file_write'],
      denyList: [],
    });
  });

  it('infers deny_list when only deny list is provided', () => {
    expect(normalizeToolAccessConfig({ toolDenyList: ['shell_exec'] })).toEqual({
      mode: 'deny_list',
      allowList: [],
      denyList: ['shell_exec'],
    });
  });

  it('reads legacy tools object allow/deny lists', () => {
    expect(
      normalizeToolAccessConfig({
        tools: {
          allow: ['tool_a'],
          deny: ['tool_b'],
        },
      })
    ).toEqual({
      mode: 'allow_list',
      allowList: ['tool_a'],
      denyList: ['tool_b'],
    });
  });

  it('trims and deduplicates lists', () => {
    expect(
      normalizeToolAccessConfig({
        toolAccessMode: 'allow_list',
        toolAllowList: [' file_read ', 'file_read', '', '   ', 'shell_exec'],
        toolDenyList: ['shell_exec', 'shell_exec', ''],
      })
    ).toEqual({
      mode: 'allow_list',
      allowList: ['file_read', 'shell_exec'],
      denyList: ['shell_exec'],
    });
  });
});
