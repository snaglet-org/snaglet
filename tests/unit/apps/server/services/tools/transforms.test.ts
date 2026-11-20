/**
 * Tests for the date-time transform tool.
 * A pure utility tool with no DB or filesystem dependencies.
 */

jest.mock('../../../../../../packages/db/index.ts', () => ({
  getPool: jest.fn(),
  // Tests mock the engine-agnostic getDb() facade.
  getDb: jest.fn(),
}));

import dateTime from '@server/services/ToolService/handlers/trivial/dateTime';

describe('date-time', () => {
  it('returns current time in UTC by default', async () => {
    const result = await dateTime({}, {});
    const parsed = JSON.parse(result);
    expect(parsed.iso).toBeDefined();
    expect(parsed.timezone).toBe('UTC');
    expect(parsed.locale).toBe('en-US');
    expect(parsed.formatted).toBeDefined();
    expect(parsed.unixMs).toBeGreaterThan(0);
    expect(parsed.unixSeconds).toBeGreaterThan(0);
  });

  it('accepts a custom timezone', async () => {
    const result = await dateTime({ timezone: 'America/New_York' }, {});
    const parsed = JSON.parse(result);
    expect(parsed.timezone).toBe('America/New_York');
  });

  it('excludes unix timestamps when includeUnix is false', async () => {
    const result = await dateTime({ includeUnix: false }, {});
    const parsed = JSON.parse(result);
    expect(parsed.unixMs).toBeUndefined();
    expect(parsed.unixSeconds).toBeUndefined();
  });

  it('rejects invalid timezone', async () => {
    await expect(dateTime({ timezone: 'Fake/Zone' }, {})).rejects.toThrow('Invalid timezone');
  });
});
