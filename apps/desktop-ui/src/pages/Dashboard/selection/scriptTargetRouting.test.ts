import { describe, expect, it } from 'vitest';
import { sidebarRevealTarget } from './types';

const script = {
  hookName: 'test-script',
  dir: '/tmp/snaglet-test/hooks/test-script',
  homeRelativeDir: '~/.snaglet/hooks/test-script',
  files: ['hook.ts'],
  hasBuild: true,
};

describe('script panes reveal in Automations', () => {
  it('"Open in sidebar" on a script page reveals its row in Automations, keyed by name', () => {
    expect(sidebarRevealTarget({ kind: 'hook', hook: script })).toEqual({
      view: 'automations',
      id: 'test-script',
    });
  });

  it('the New script page switches to Automations', () => {
    expect(sidebarRevealTarget({ kind: 'hook-create' })).toEqual({
      view: 'automations',
      id: null,
    });
  });
});
