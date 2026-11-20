/**
 * Tool-catalog selection smoke: one natural-language scenario for each major
 * consolidated surface. Core choices must be directly advertised; on-demand
 * choices must be discoverable in search_tools' three-result keyword window.
 */

import { CORE_TOOL_IDS } from '@snaglet/shared/constants';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import searchTools from '@server/services/ToolService/handlers/tools/tool-search';

type Scenario =
  | { prompt: string; expected: string; route: 'core' }
  | { prompt: string; expected: string; route: 'discovery' };

const SCENARIOS: Scenario[] = [
  { prompt: 'find my notes on project X', expected: 'search', route: 'core' },
  { prompt: 'remember that the launch is Friday', expected: 'memory', route: 'core' },
  { prompt: 'what do I remember about the launch?', expected: 'memory', route: 'core' },
  { prompt: 'read these three files', expected: 'file', route: 'core' },
  { prompt: 'find files named config', expected: 'file', route: 'core' },
  { prompt: 'create a project brief document', expected: 'doc', route: 'core' },
  { prompt: 'send an email', expected: 'google_gmail', route: 'discovery' },
  { prompt: 'commit these changes with git', expected: 'git', route: 'discovery' },
  {
    prompt: 'what did agent Y do yesterday? show activity history',
    expected: 'agent',
    route: 'discovery',
  },
  { prompt: 'send an iMessage', expected: 'imessage', route: 'discovery' },
  { prompt: 'schedule a calendar event', expected: 'google_calendar', route: 'discovery' },
  {
    prompt: 'upload a file to Google Drive',
    expected: 'google_drive_admin',
    route: 'discovery',
  },
];

describe('tool catalog selection smoke', () => {
  beforeAll(async () => {
    await toolRegistry.load();
    await toolRegistry.syncToDatabase();
  }, 120_000);

  it.each(SCENARIOS)('$prompt selects $expected through $route', async (scenario) => {
    if (scenario.route === 'core') {
      expect(CORE_TOOL_IDS.has(scenario.expected)).toBe(true);
      return;
    }

    const raw = await searchTools({ query: scenario.prompt, mode: 'keyword' });
    expect(typeof raw).toBe('string');
    const result = JSON.parse(raw as string) as {
      tools: Array<{ id: string }>;
    };
    expect(result.tools.map((tool) => tool.id)).toContain(scenario.expected);
  });
});
