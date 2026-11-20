import { describe, expect, it } from 'vitest';
import { byCreatedAt, compareInstants } from './chronology';

describe('compareInstants', () => {
  it('orders a UTC and an offset timestamp by the instant, not the text', () => {
    // 18:01:42Z is 10:01:42-08:00; the event row came 30 s later.
    const userMessage = '2026-10-13T18:01:42.864Z';
    const eventRow = '2026-10-13T10:02:12.120000-08:00';
    expect(eventRow < userMessage).toBe(true); // plain string order is wrong
    expect(compareInstants(eventRow, userMessage)).toBe(1);
    expect(compareInstants(userMessage, eventRow)).toBe(-1);
    expect(compareInstants('2026-10-13T18:01:42.864Z', '2026-10-13T10:01:42.864-08:00')).toBe(0);
  });

  it('puts unparsable or missing values first, consistently', () => {
    expect(compareInstants('', '2026-10-13T18:00:00Z')).toBe(-1);
    expect(compareInstants('2026-10-13T18:00:00Z', null)).toBe(1);
    expect(compareInstants(undefined, null)).toBe(0);
    expect(compareInstants('later', 'earlier')).toBe(1);
  });

  it('keeps the existing order of equal instants (stable sort)', () => {
    const rows = [
      { id: 'b', createdAt: '2026-10-13T18:00:00.000Z' },
      { id: 'a', createdAt: '2026-10-13T10:00:00.000-08:00' },
      { id: 'c', createdAt: '2026-10-13T09:59:59.000-08:00' },
    ];
    expect([...rows].sort(byCreatedAt).map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });
});
