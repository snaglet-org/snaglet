/**
 * The always-available tools. The tool-access editor shows
 * `tool` and `get_current_datetime` as always available and reads any
 * entry naming them as having no effect, from the same shared set the server
 * checks. These pin that the server's check uses that set and that no allow
 * or deny entry, by id or another name, gates either tool.
 */
import type { ToolAccessConfig } from '@snaglet/shared/types';
import { ALWAYS_AVAILABLE_TOOL_IDS } from '@snaglet/shared/constants';
import { isAlwaysAvailableTool } from '@server/services/ToolService/lib/alwaysAvailableTools';
import { evaluateToolPermission } from '@server/services/ToolService/lib/toolPermission';

// The clock's real definition names (get-current-datetime/definition.ts).
const CLOCK_NAMES = ['now', 'today', 'current_time', 'current_datetime'];

const config = (
  mode: ToolAccessConfig['mode'],
  lists: Partial<Pick<ToolAccessConfig, 'allowList' | 'denyList'>>
): ToolAccessConfig => ({ mode, allowList: [], denyList: [], ...lists });

describe('always-available tools', () => {
  it('is search and the clock, from the shared set', () => {
    expect([...ALWAYS_AVAILABLE_TOOL_IDS].sort()).toEqual(['get_current_datetime', 'tool']);
    for (const id of ALWAYS_AVAILABLE_TOOL_IDS) expect(isAlwaysAvailableTool(id)).toBe(true);
    expect(isAlwaysAvailableTool('shell')).toBe(false);
    expect(isAlwaysAvailableTool('search_tools')).toBe(false); // alias id: aliases resolve to `tool` before the check
  });

  it.each(['allow_list', 'deny_list'] as const)(
    'no deny entry blocks them in %s mode, by id or definition name',
    (mode) => {
      const options = { toolAliases: CLOCK_NAMES };
      for (const entry of ['get_current_datetime', 'now', 'Today', 'date_time']) {
        const verdict = evaluateToolPermission(
          config(mode, { denyList: [entry] }),
          'get_current_datetime',
          {},
          options
        );
        expect(verdict.decision).toBe('allow');
      }
      for (const entry of ['search_tools', 'list_tools']) {
        const verdict = evaluateToolPermission(config(mode, { denyList: [entry] }), 'tool', {
          query: 'git',
        });
        expect(verdict.decision).toBe('allow');
      }
    }
  );

  it('an allow list that leaves them out still allows them', () => {
    const onlyShell = config('allow_list', { allowList: ['shell'] });
    expect(evaluateToolPermission(onlyShell, 'tool', { query: 'x' }).decision).toBe('allow');
    expect(evaluateToolPermission(onlyShell, 'get_current_datetime', {}).decision).toBe('allow');
  });
});
