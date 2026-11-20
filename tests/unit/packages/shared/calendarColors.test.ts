import { describe, expect, it } from '@jest/globals';
import { CALENDAR_COLORS } from '@snaglet/shared/types';
import {
  CALENDAR_COLOR_FORMATS,
  calendarColorParts,
  normalizeCalendarColor,
  normalizeHexColor,
} from '@snaglet/shared/utils';

describe('calendar colors', () => {
  it('keeps every palette id as it is', () => {
    for (const id of CALENDAR_COLORS) {
      expect(normalizeCalendarColor(id)).toBe(id);
      expect(calendarColorParts(id)).toEqual({ kind: 'palette', color: id });
    }
  });

  it('takes a workspace theme token by name; a renamed token resolves to its successor', () => {
    expect(calendarColorParts('theme:detail')).toEqual({
      kind: 'theme',
      color: 'theme:detail',
      token: 'detail',
    });
    expect(normalizeCalendarColor('theme:color-node-thread')).toBe('theme:color-node-thread');
    expect(normalizeCalendarColor('theme:color-node-agent')).toBe('theme:agent');
    expect(normalizeCalendarColor('theme:panel')).toBe('theme:foreground');
  });

  it('normalizes a custom hex to lowercase #rrggbb', () => {
    expect(normalizeCalendarColor('#3A7BD5')).toBe('#3a7bd5');
    expect(normalizeCalendarColor('#AbC')).toBe('#aabbcc');
    expect(normalizeCalendarColor(' #3a7bd5 ')).toBe('#3a7bd5');
    expect(calendarColorParts('#3a7bd5')).toEqual({ kind: 'custom', color: '#3a7bd5' });
    expect(normalizeHexColor('#12345')).toBeNull();
  });

  it('rejects anything else', () => {
    for (const bad of [
      'plaid',
      'Blue',
      '3a7bd5',
      '#3a7bd',
      '#3a7bd5ff',
      'rgb(1, 2, 3)',
      'var(--detail)',
      'theme:',
      'theme:nope',
      'theme:constructor',
      'theme:color-container-status',
      '',
      null,
      undefined,
      42,
      {},
    ])
      expect(normalizeCalendarColor(bad)).toBeNull();
  });

  it('names every accepted form for a 400 or a tool description', () => {
    expect(CALENDAR_COLOR_FORMATS).toContain('null (automatic)');
    expect(CALENDAR_COLOR_FORMATS).toContain(CALENDAR_COLORS.join(', '));
    expect(CALENDAR_COLOR_FORMATS).toContain('theme:<token>');
    expect(CALENDAR_COLOR_FORMATS).toContain('detail');
    expect(CALENDAR_COLOR_FORMATS).toContain('#3a7bd5');
  });
});
