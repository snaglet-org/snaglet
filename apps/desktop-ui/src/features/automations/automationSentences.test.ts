import { describe, expect, it } from 'vitest';
import { HOOK_EVENT_NAMES } from '@snaglet/sdk';
import type { AutomationWhen } from '@snaglet/shared/types';
import { describeAutomationWhen } from '@snaglet/shared/utils';
import { automationSentence, scriptEventLabel, scriptSentence } from './automationSentences';
import { automationRecord } from './testFixtures';

/** A record as the server sends it: `whenText` is the shared describer's words. */
const sentenceFor = (when: AutomationWhen, over: Parameters<typeof automationRecord>[0] = {}) =>
  automationSentence(
    automationRecord({ when, whenText: describeAutomationWhen(when, 'UTC'), ...over })
  );

describe('automationSentence: each schedule kind, in the shared words', () => {
  it('a repeat reads its rule and time on the 12-hour clock', () => {
    expect(
      sentenceFor({
        kind: 'repeat',
        rrule: 'FREQ=DAILY',
        timeOfDay: '04:30',
        startsOn: '2026-11-01',
        tz: 'UTC',
      })
    ).toBe('Every day at 4:30 AM → wake Test Agent A in Test thread');
    expect(
      sentenceFor({
        kind: 'repeat',
        rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
        timeOfDay: '16:05',
        startsOn: '2026-11-01',
        tz: 'UTC',
      })
    ).toBe('Every weekday at 4:05 PM → wake Test Agent A in Test thread');
  });

  it('a first-open one reads its earliest time', () => {
    expect(
      sentenceFor({ kind: 'first_open', after: '05:00', tz: 'UTC' }, { threadTitle: null })
    ).toBe('When Snaglet first opens, after 5:00 AM → wake Test Agent A');
  });

  it('an interval reads its step, and its daily window when it has one', () => {
    expect(
      sentenceFor({
        kind: 'interval',
        everyMs: 5 * 60_000,
        tz: 'UTC',
        windowStart: '04:35',
        windowEnd: '05:45',
      })
    ).toBe('Every 5 minutes from 4:35 AM to 5:45 AM → wake Test Agent A in Test thread');
    expect(sentenceFor({ kind: 'interval', everyMs: 2 * 3_600_000, tz: 'UTC' })).toBe(
      'Every 2 hours → wake Test Agent A in Test thread'
    );
  });

  it('a once reads its date and time', () => {
    expect(
      sentenceFor(
        { kind: 'once', at: '2026-11-06T09:00:00.000Z', tz: 'UTC' },
        { agentName: 'Test Agent B' }
      )
    ).toBe('Once on Fri, Nov 6, 9:00 AM → wake Test Agent B in Test thread');
  });

  it('keeps the zone the shared words name', () => {
    expect(
      automationSentence(
        automationRecord({ whenText: 'every day at 4:30 AM (America/New_York)', threadTitle: null })
      )
    ).toBe('Every day at 4:30 AM (America/New_York) → wake Test Agent A');
  });

  it('says "an agent" when the agent is gone', () => {
    expect(
      sentenceFor({ kind: 'first_open', after: '05:00', tz: 'UTC' }, { agentName: null })
    ).toBe('When Snaglet first opens, after 5:00 AM → wake an agent in Test thread');
  });
});

describe('scriptSentence', () => {
  const declared = (events: string[], schedules: unknown[] = []) => ({ events, schedules });

  it('joins events about the same thing', () => {
    expect(
      scriptSentence(
        'notify-on-done',
        declared(['table_entry:create', 'table_entry:update']),
        'UTC'
      )
    ).toBe('When a table row is created or changed → run notify-on-done');
    expect(scriptSentence('nightly-report', declared(['run:end']), 'UTC')).toBe(
      'When a run ends → run nightly-report'
    );
  });

  it('joins different things with "or", and three or more with commas', () => {
    expect(scriptSentence('test-script', declared(['message:create', 'run:end']), 'UTC')).toBe(
      'When a message is sent or a run ends → run test-script'
    );
    expect(
      scriptSentence('test-script', declared(['message:create', 'thread:create', 'run:end']), 'UTC')
    ).toBe('When a message is sent, a thread is created or a run ends → run test-script');
  });

  it('has plain words for every event a script can start on', () => {
    const v2Events = ['hook:finished', 'hook:signal'];
    for (const event of [...HOOK_EVENT_NAMES, ...v2Events]) {
      const label = scriptEventLabel(event);
      expect(label.subject, event).not.toMatch(/^the .* event$/);
      expect(label.happened, event).not.toBe(event);
    }
  });

  it('names an unknown event as it is', () => {
    expect(scriptSentence('test-script', declared(['custom:thing']), 'UTC')).toBe(
      'When the custom:thing event fires → run test-script'
    );
    expect(scriptEventLabel('custom:thing').happened).toBe('custom:thing');
  });

  it('words the schedules a script declares as automations are worded', () => {
    const sentence = (schedule: unknown) =>
      scriptSentence('test-script', declared([], [schedule]), 'UTC');
    expect(sentence({ every: 5, unit: 'minute' })).toBe('Every 5 minutes → run test-script');
    expect(sentence({ every: 1, unit: 'week' })).toBe('Every 7 days → run test-script');
    expect(sentence({ time: '09:00', timezone: 'UTC' })).toBe(
      'Every day at 9:00 AM → run test-script'
    );
    expect(sentence({ time: '09:00', timezone: 'UTC', weekdays: [1, 2, 3, 4, 5] })).toBe(
      'Every weekday at 9:00 AM → run test-script'
    );
    expect(sentence({ time: '21:00', timezone: 'UTC', weekdays: [3, 1] })).toBe(
      'Every week on Monday, Wednesday at 9:00 PM → run test-script'
    );
    expect(sentence({ time: '09:00', timezone: 'America/New_York' })).toBe(
      'Every day at 9:00 AM (America/New_York) → run test-script'
    );
    expect(sentence({ at: '2026-11-06T09:00:00.000Z' })).toBe(
      'Once on Fri, Nov 6, 9:00 AM → run test-script'
    );
    expect(sentence({ cron: '* * * * *' })).toBe('On a schedule → run test-script');
    // The same words as an automation with that timing.
    expect(sentence({ time: '09:00', timezone: 'UTC' })).toBe(
      `${
        sentenceFor({
          kind: 'repeat',
          rrule: 'FREQ=DAILY',
          timeOfDay: '09:00',
          startsOn: '2026-11-01',
          tz: 'UTC',
        }).split(' → ')[0]
      } → run test-script`
    );
  });

  it('joins events and schedules with "or"', () => {
    expect(
      scriptSentence(
        'test-script',
        declared(['run:end'], [{ time: '09:00', timezone: 'UTC' }]),
        'UTC'
      )
    ).toBe('When a run ends, or every day at 9:00 AM → run test-script');
  });

  it('says only the action while nothing is known, and "by hand" when nothing is declared', () => {
    expect(scriptSentence('test-script', null, 'UTC')).toBe('Run test-script');
    expect(scriptSentence('test-script', declared([]), 'UTC')).toBe(
      'Only when run by hand → run test-script'
    );
  });
});
