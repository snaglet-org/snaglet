import { describe, expect, it, jest } from '@jest/globals';
import { createSafetyNetReporter } from '@server/config/processSafetyNets';

describe('createSafetyNetReporter', () => {
  it('drops a report raised while another is in progress', () => {
    const reported: string[] = [];
    const reporter = createSafetyNetReporter((label: string) => {
      reported.push(label);
      // Logging the failure fails the same way and re-enters the handler.
      reporter(`${label} (re-raised)`);
    });

    reporter('first');
    reporter('second');

    expect(reported).toEqual(['first', 'second']);
  });

  it('suppresses a burst past the per-window limit and notes it once', () => {
    let now = 1_000;
    const report = jest.fn();
    const onSuppressed = jest.fn();
    const reporter = createSafetyNetReporter(report, {
      maxReportsPerWindow: 3,
      windowMs: 60_000,
      onSuppressed,
      now: () => now,
    });

    for (let i = 0; i < 50; i += 1) reporter();
    expect(report).toHaveBeenCalledTimes(3);
    expect(onSuppressed).toHaveBeenCalledTimes(1);
    expect(onSuppressed).toHaveBeenCalledWith(60_000);

    now += 60_000;
    for (let i = 0; i < 5; i += 1) reporter();
    expect(report).toHaveBeenCalledTimes(6);
    expect(onSuppressed).toHaveBeenCalledTimes(2);
  });

  it('swallows a reporter that throws and keeps reporting afterward', () => {
    const report = jest
      .fn<(label: string) => void>()
      .mockImplementationOnce(() => {
        throw new Error('write EPIPE');
      })
      .mockImplementation(() => undefined);
    const reporter = createSafetyNetReporter(report);

    expect(() => reporter('first')).not.toThrow();
    reporter('second');

    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith('second');
  });
});
