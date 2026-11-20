/**
 * When a timed pause of a subagent helper ends: the `for` lengths and
 * `until` times the subagent tool and the REST route accept, and the bounds.
 */
import { describe, expect, it } from '@jest/globals';
import { SubagentError } from '@server/services/subagents/errors';
import {
  PAUSE_MAX_MS,
  parsePauseDuration,
  resolveResumeAt,
} from '@server/services/subagents/pauseTime';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

describe('parsePauseDuration', () => {
  it('reads number + unit pieces in the usual spellings', () => {
    expect(parsePauseDuration('15m')).toBe(15 * MIN);
    expect(parsePauseDuration('2h')).toBe(2 * HOUR);
    expect(parsePauseDuration('1h30m')).toBe(90 * MIN);
    expect(parsePauseDuration('1h 30m')).toBe(90 * MIN);
    expect(parsePauseDuration('90 minutes')).toBe(90 * MIN);
    expect(parsePauseDuration('1.5 hours')).toBe(90 * MIN);
    expect(parsePauseDuration('2 hours and 15 mins')).toBe(135 * MIN);
    expect(parsePauseDuration('1 day')).toBe(24 * HOUR);
    expect(parsePauseDuration(' 45 MIN ')).toBe(45 * MIN);
    expect(parsePauseDuration('30s')).toBe(30_000);
  });

  it('reads ISO 8601 durations', () => {
    expect(parsePauseDuration('PT15M')).toBe(15 * MIN);
    expect(parsePauseDuration('PT1H30M')).toBe(90 * MIN);
    expect(parsePauseDuration('P1D')).toBe(24 * HOUR);
  });

  it('refuses anything else', () => {
    for (const text of ['', '15', 'soon', '15 parsecs', '15m later', 'PT', 'P', 'm15']) {
      expect(parsePauseDuration(text)).toBeNull();
    }
  });
});

describe('resolveResumeAt', () => {
  it('is null for a pause with no timer', () => {
    expect(resolveResumeAt({}, NOW)).toBeNull();
    expect(resolveResumeAt({ for: '  ', until: null }, NOW)).toBeNull();
  });

  it('adds a length to now', () => {
    expect(resolveResumeAt({ for: '15m' }, NOW)?.toISOString()).toBe('2026-10-13T12:15:00.000Z');
    expect(resolveResumeAt({ for: '2h' }, NOW)?.toISOString()).toBe('2026-10-13T14:00:00.000Z');
  });

  it('takes an ISO time with or without a zone', () => {
    expect(resolveResumeAt({ until: '2026-10-13T15:00:00Z' }, NOW)?.toISOString()).toBe(
      '2026-10-13T15:00:00.000Z'
    );
    expect(resolveResumeAt({ until: '2026-10-13T08:00:00-07:00' }, NOW)?.toISOString()).toBe(
      '2026-10-13T15:00:00.000Z'
    );
    // No zone: the server's local time, i.e. the user's machine.
    const local = resolveResumeAt({ until: '2026-10-14T09:30' }, NOW);
    expect(local?.getTime()).toBe(new Date(2026, 9, 14, 9, 30).getTime());
  });

  it('refuses both at once, a bad value, too short, the past and more than 7 days', () => {
    const refused = (input: Parameters<typeof resolveResumeAt>[0]) => {
      try {
        resolveResumeAt(input, NOW);
      } catch (err) {
        expect(err).toBeInstanceOf(SubagentError);
        return (err as Error).message;
      }
      throw new Error('expected a refusal');
    };
    expect(refused({ for: '15m', until: '2026-10-13T15:00:00Z' })).toBe(
      'give for or until, not both.'
    );
    expect(refused({ for: 'soon' })).toMatch(/^for must be a length such as "15m"/);
    expect(refused({ for: 15 })).toBe('for must be a string.');
    expect(refused({ for: '30s' })).toBe('for must be at least 1 minute.');
    expect(refused({ until: 'tomorrow' })).toMatch(/^until must be an ISO date and time/);
    expect(refused({ until: '2026-10-14' })).toMatch(/^until must be an ISO date and time/);
    expect(refused({ until: '2026-10-13T11:00:00Z' })).toBe('until must be in the future.');
    expect(refused({ for: '8d' })).toBe('a timed pause can last at most 7 days.');
    expect(refused({ until: '2026-10-21T12:00:00Z' })).toBe(
      'a timed pause can last at most 7 days.'
    );
    expect(resolveResumeAt({ for: `${PAUSE_MAX_MS / 1000}s` }, NOW)).not.toBeNull();
  });
});
