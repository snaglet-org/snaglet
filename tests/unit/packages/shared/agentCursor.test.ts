import {
  CURSOR_FLOWERS,
  CURSOR_FLOWER_COLORS,
  blossomOutline,
  clickRingColor,
  darken,
  defaultCursorFlower,
  resolveAgentCursor,
} from '@snaglet/shared/constants/agentCursor';

describe('agent cursor defaults', () => {
  it('blossom is first and the default for every agent', () => {
    expect(CURSOR_FLOWERS[0]).toBe('blossom');
    expect(CURSOR_FLOWER_COLORS.blossom).toBe('#FF9EC7');
    expect(defaultCursorFlower('a')).toBe('blossom');
    expect(defaultCursorFlower('zzz-other')).toBe('blossom');
    expect(resolveAgentCursor('x')).toEqual({ flower: 'blossom', color: '#FF9EC7' });
  });

  it('keeps an explicit flower or color', () => {
    expect(resolveAgentCursor('x', 'rose', null)).toEqual({
      flower: 'rose',
      color: CURSOR_FLOWER_COLORS.rose,
    });
    expect(resolveAgentCursor('x', null, '#112233')).toEqual({
      flower: 'blossom',
      color: '#112233',
    });
    expect(resolveAgentCursor('x', 'nope', null).flower).toBe('blossom');
  });
});

describe('darken', () => {
  it('scales channels toward black', () => {
    expect(darken('#ffffff', 0.5)).toBe('#808080');
    expect(darken('#ff0000', 0)).toBe('#ff0000');
    expect(darken('#ff8040', 1)).toBe('#000000');
  });
  it('clamps amount and ignores non-hex input', () => {
    expect(darken('#ffffff', 5)).toBe('#000000');
    expect(darken('#ffffff', -1)).toBe('#ffffff');
    expect(darken('red', 0.2)).toBe('red');
  });
});

describe('blossom colors', () => {
  it('uses the demo outline and ring on the default pink, derived shades otherwise', () => {
    expect(blossomOutline('#ff9ec7')).toBe('#EE669E');
    expect(blossomOutline('#4f9be8')).toBe(darken('#4f9be8', 0.25));
    expect(clickRingColor('blossom', '#FF9EC7')).toBe('#FF8CB3');
    expect(clickRingColor('blossom', '#4f9be8')).toBe('#4f9be8');
    expect(clickRingColor('rose', '#d93b4a')).toBe('#d93b4a');
  });
});
