import { describe, expect, it } from 'vitest';
import { chipHrefForNode, nodeToChipMarkdown } from '@desktop/utils/nodeChip';
import { NODE_HREF_SOURCE, TOOL_HREF_SOURCE, parseNodeRef } from './nodeRef';

const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

// Custom tool ids are name slugs (`weather`, `weather_today`), not timestamp
// ids or UUIDs, so `tool:` takes the tool id grammar instead of the node-id one.
describe('tool chip hrefs', () => {
  it('parse slug tool ids', () => {
    expect(parseNodeRef('tool:weather')).toEqual({ kind: 'tool', id: 'weather' });
    expect(parseNodeRef('tool:weather_today')).toEqual({ kind: 'tool', id: 'weather_today' });
    expect(parseNodeRef('tool:weather-today')).toEqual({ kind: 'tool', id: 'weather-today' });
  });

  it('still parse the timestamp and UUID forms', () => {
    expect(parseNodeRef(`tool:${UUID}`)).toEqual({ kind: 'tool', id: UUID });
    expect(parseNodeRef('tool-1111111111111-aaaaaaaaa')).toEqual({
      kind: 'tool',
      id: 'tool-1111111111111-aaaaaaaaa',
    });
  });

  it('reject a body outside the tool id grammar', () => {
    expect(parseNodeRef('tool:')).toBeNull();
    expect(parseNodeRef('tool:weather today')).toBeNull();
    expect(parseNodeRef('tool:weather!')).toBeNull();
    expect(parseNodeRef('tool:weather.today')).toBeNull();
    expect(parseNodeRef('tool:weather/today')).toBeNull();
  });

  it('leave every other kind on the node-id grammar', () => {
    expect(parseNodeRef('doc:weather')).toBeNull();
    expect(parseNodeRef('thread:weather_today')).toBeNull();
    expect(parseNodeRef('page:weather')).toBeNull();
    expect(parseNodeRef('tool-weather')).toBeNull();
  });

  it('round-trip through the chip markdown encoder', () => {
    const chip = { id: 'weather_today', kind: 'tool' as const, title: 'Weather today' };
    expect(chipHrefForNode(chip)).toBe('tool:weather_today');
    expect(nodeToChipMarkdown(chip)).toBe('[Weather today](tool:weather_today)');
    expect(parseNodeRef(chipHrefForNode(chip))).toEqual({ kind: 'tool', id: 'weather_today' });
  });

  // The prose bare-id grammar must not chip text such as `tool:create`.
  it('stay out of the prose node-href grammar', () => {
    const re = new RegExp(`^${NODE_HREF_SOURCE}$`);
    expect(re.test('tool:weather')).toBe(false);
    expect(re.test(`tool:${UUID}`)).toBe(true);
  });

  it('are matched on their own by the tool-href grammar', () => {
    const re = new RegExp(TOOL_HREF_SOURCE, 'g');
    const matches = (text: string) => [...text.matchAll(re)].map((m) => m[0]);
    expect(matches('tool:weather_today')).toEqual(['tool:weather_today']);
    expect(matches('(tool:weather)')).toEqual(['tool:weather']);
    expect(matches('stool:sample socket:tool:create [tool:policy]')).toEqual([]);
    expect(matches(`tool:${UUID}#L2`)).toEqual([]);
  });
});
