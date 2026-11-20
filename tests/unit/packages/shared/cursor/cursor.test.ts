import {
  ALL_THEME_TOKENS,
  CENTER_TOKENS,
  EMOTIONS,
  EMOTION_IDS,
  PETAL_TOKENS,
  SHAPE_RANGES,
  STATUS_EMOTION,
  STATUS_IDS,
  contrastRatio,
  defaultCursorSpec,
  describeFlower,
  flowerSvgString,
  generateColors,
  generateCursorSpec,
  generateShape,
  isThemeToken,
  makeRng,
  pickReadable,
  seedFromId,
  validateCursorSpec,
} from '@snaglet/shared/cursor';
import { defaultTheme } from '@snaglet/theme';

const palette = Object.fromEntries(
  ALL_THEME_TOKENS.map((t, i) => [t, `hsl(${(i * 47) % 360}, 60%, ${20 + ((i * 13) % 60)}%)`])
);

describe('prng', () => {
  it('seedFromId is a stable non-negative int', () => {
    expect(seedFromId('agent-1')).toBe(seedFromId('agent-1'));
    expect(seedFromId('')).toBe(5381);
    for (const id of ['a', 'zzzzzzzzzzzzzzzzzzzzzz', 'ünï']) {
      const s = seedFromId(id);
      expect(Number.isInteger(s) && s >= 0).toBe(true);
    }
  });
  it('makeRng is deterministic and in [0,1)', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v >= 0 && v < 1).toBe(true);
    }
  });
});

describe('generation', () => {
  it('is deterministic', () => {
    expect(generateCursorSpec(7)).toEqual(generateCursorSpec(7));
    expect(defaultCursorSpec('abc')).toEqual(defaultCursorSpec('abc'));
    expect(generateCursorSpec(7)).not.toEqual(generateCursorSpec(8));
  });

  it('stays in range and valid over 2000 seeds', () => {
    for (let seed = 0; seed < 2000; seed++) {
      const spec = generateCursorSpec(seed);
      expect(() => validateCursorSpec(spec)).not.toThrow();
      const s = spec.shape;
      for (const v of Object.values(s)) {
        if (typeof v === 'number') expect(Number.isNaN(v)).toBe(false);
      }
      const mid = s.b + (s.t - s.b) * s.pos;
      expect(s.w).toBeLessThanOrEqual(mid * Math.sin(Math.PI / s.n) * 1.3 + 0.1);
      expect(s.ring && s.n < 5).toBe(false);
      expect(SHAPE_RANGES.n.min <= s.n && s.n <= SHAPE_RANGES.n.max).toBe(true);
    }
  });

  it('color roles: ring != petal, center != petal, tokens in lists', () => {
    for (let seed = 0; seed < 2000; seed++) {
      const c = generateColors(seed);
      expect(c.ring).not.toBe(c.petal);
      expect(c.center).not.toBe(c.petal);
      expect((PETAL_TOKENS as readonly string[]).includes(c.petal)).toBe(true);
      expect((CENTER_TOKENS as readonly string[]).includes(c.center)).toBe(true);
      expect(isThemeToken(c.feature) && isThemeToken(c.cheek) && isThemeToken(c.outline)).toBe(
        true
      );
    }
  });
});

describe('validateCursorSpec', () => {
  const good = () => JSON.parse(JSON.stringify(generateCursorSpec(3)));
  it('accepts a generated spec', () => {
    expect(validateCursorSpec(good())).toEqual(good());
  });
  it('rejects bad input', () => {
    expect(() => validateCursorSpec(null)).toThrow(/object/);
    expect(() => validateCursorSpec({ ...good(), v: 2 })).toThrow(/cursorSpec.v/);
    expect(() => validateCursorSpec({ ...good(), extra: 1 })).toThrow(/unexpected key "extra"/);
    let s = good();
    s.shape.n = 99;
    expect(() => validateCursorSpec(s)).toThrow(/shape.n/);
    s = good();
    s.shape.n = 5.5;
    expect(() => validateCursorSpec(s)).toThrow(/integer/);
    s = good();
    s.shape.t = Number.NaN;
    expect(() => validateCursorSpec(s)).toThrow(/finite/);
    s = good();
    s.shape.ring = 'yes';
    expect(() => validateCursorSpec(s)).toThrow(/boolean/);
    s = good();
    s.shape.bogus = 1;
    expect(() => validateCursorSpec(s)).toThrow(/unexpected key/);
    s = good();
    s.colors.petal = '#ff0000';
    expect(() => validateCursorSpec(s)).toThrow(/colors.petal/);
    s = good();
    s.colors.feature = 'disabled'; // a token, but not allowed for this role
    expect(() => validateCursorSpec(s)).toThrow(/colors.feature/);
    s = good();
    s.colors.extra = 'text';
    expect(() => validateCursorSpec(s)).toThrow(/unexpected key/);
    s = good();
    delete s.colors.cheek;
    expect(() => validateCursorSpec(s)).toThrow(/missing key/);
  });
});

describe('contrast', () => {
  it('computes WCAG ratios', () => {
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 0);
    expect(contrastRatio('rgb(255,255,255)', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('hsl(0, 0%, 0%)', 'white-ish')).toBe(1);
  });
  it('pickReadable', () => {
    expect(pickReadable(['#fff', '#000'], '#ffffff')).toBe('#000');
    expect(pickReadable(['#eee', '#ddd'], '#ffffff')).toBe('#ddd');
  });
});

describe('describeFlower', () => {
  const spec = generateCursorSpec(11);
  it('is pure and covers every emotion', () => {
    for (const emo of EMOTION_IDS) {
      const d = describeFlower(spec, emo, palette);
      expect(d).toEqual(describeFlower(spec, emo, palette));
      expect(d.petalsD).not.toMatch(/NaN|undefined/);
      expect(JSON.stringify(d)).not.toMatch(/NaN|undefined/);
    }
  });
  it('swaps a feature color that matches the center', () => {
    const s = {
      ...spec,
      colors: {
        ...spec.colors,
        feature: 'text' as const,
        center: 'background' as const,
        petal: 'detail' as const,
      },
    };
    const pal = {
      ...palette,
      text: '#ffffff',
      background: '#ffffff',
      border: '#202020',
      detail: '#7755cc',
    };
    const d = describeFlower(s, 'neutral', pal);
    expect(contrastRatio(d.colors.feature, d.colors.centerFill)).toBeGreaterThanOrEqual(4.5);
    expect(d.colors.feature).not.toBe('#ffffff');
  });
  it('keeps center distinct from petal', () => {
    const s = {
      ...spec,
      colors: { ...spec.colors, petal: 'detail' as const, center: 'agent' as const },
    };
    const pal = { ...palette, detail: '#336699', agent: '#336699', 'activity-bar': '#ffffff' };
    const d = describeFlower(s, 'happy', pal);
    expect(contrastRatio(d.colors.centerFill, d.colors.petalFill)).toBeGreaterThanOrEqual(1.25);
  });
  it('falls back for missing or unsafe palette keys', () => {
    const d = describeFlower(spec, 'neutral', { text: 'url(javascript:alert(1))' });
    expect(d.colors.petalFill).toBe(defaultTheme.agent);
    expect(JSON.stringify(d.colors)).not.toMatch(/url|javascript/);
  });
  it('animate:false is static', () => {
    const d = describeFlower(spec, 'proud', palette, { animate: false });
    expect(d.animate).toBe(false);
    expect(d.bounceVals).toBe('0 0;0 0;0 0');
    expect(d.pulseVals).toBe('1;1;1');
    expect(d.swayVals).toBe('0 0 0;0 0 0;0 0 0');
    expect(d.blinkVals).toBe('1 1;1 1;1 1;1 1');
    expect(flowerSvgString(d, 40)).not.toContain('animate');
  });
});

describe('flowerSvgString', () => {
  it('is safe and well formed', () => {
    for (let seed = 0; seed < 50; seed++) {
      for (const emo of EMOTION_IDS) {
        const svg = flowerSvgString(describeFlower(generateCursorSpec(seed), emo, palette), 48);
        expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="')).toBe(true);
        expect(svg.endsWith('</svg>')).toBe(true);
        expect(svg).not.toMatch(/<script|href|<style|style=|javascript|on\w+=|NaN|undefined/i);
        expect(svg).toContain('animateTransform');
        // balanced <g>
        expect((svg.match(/<g[ >]/g) ?? []).length).toBe((svg.match(/<\/g>/g) ?? []).length);
      }
    }
  });
  it('sanitizes hostile description fields', () => {
    const d = describeFlower(generateCursorSpec(1), 'surprised', palette);
    d.colors.petalFill = '"/><script>alert(1)</script>';
    d.petalsD = 'M 0 0"/><script>';
    d.badge.glyph = '<b>';
    const svg = flowerSvgString(d, 9999);
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('<b>');
    expect(svg).toContain('width="1024"');
  });
});

describe('status mapping', () => {
  it('covers every status with a real emotion', () => {
    for (const s of STATUS_IDS) expect(EMOTIONS[STATUS_EMOTION[s]]).toBeDefined();
    expect(STATUS_EMOTION.typing).toBe('happy');
  });
});

describe('angry, embarrassed and annoyed emotions', () => {
  const spec = generateCursorSpec(5);
  const faces = ['angry', 'embarrassed', 'annoyed'] as const;
  it('are registered expressions and svg-safe', () => {
    for (const id of faces) {
      expect(EMOTION_IDS).toContain(id);
      expect(EMOTIONS[id]).toBeDefined();
      const d = describeFlower(spec, id, palette);
      expect(d.emotion).toBe(id);
      expect(JSON.stringify(d)).not.toMatch(/NaN|undefined/);
      const svg = flowerSvgString(d, 48);
      expect(svg).not.toMatch(/<script|href|<style|style=|javascript|on\w+=|NaN|undefined/i);
      expect((svg.match(/<g[ >]/g) ?? []).length).toBe((svg.match(/<\/g>/g) ?? []).length);
    }
  });
  it('angry: angled brows, frown, red flush, and a fast side-to-side shake that goes still', () => {
    const n = describeFlower(spec, 'neutral', palette);
    const d = describeFlower(spec, 'angry', palette);
    expect(d.browsD).not.toBe('');
    expect(d.mouthD).not.toBe(n.mouthD);
    expect(d.colors.cheek).not.toBe(n.colors.cheek);
    expect(d.bounceVals).toBe('-6 0;6 0;-6 0');
    expect(parseFloat(d.bounceDur)).toBeLessThan(0.3);
    const still = describeFlower(spec, 'angry', palette, { animate: false });
    expect(still.bounceVals).toBe('0 0;0 0;0 0');
    expect(flowerSvgString(still, 40)).not.toContain('animate');
  });
  it('only angry shakes', () => {
    for (const emo of EMOTION_IDS) {
      if (emo === 'angry') continue;
      expect(EMOTIONS[emo].shake).toBeUndefined();
    }
  });
  it('embarrassed: wide eyes, small mouth, big rosy cheeks', () => {
    const n = describeFlower(spec, 'neutral', palette);
    const d = describeFlower(spec, 'embarrassed', palette);
    expect(EMOTIONS.embarrassed.eyes).toBe('wide');
    expect(EMOTIONS.embarrassed.mouth).toBe('small');
    expect(d.cheeks.r).toBeGreaterThan(n.cheeks.r);
    expect(d.cheeks.opacity).toBeGreaterThan(n.cheeks.opacity);
    expect(d.colors.cheek).not.toBe(n.colors.cheek);
  });
  it('annoyed: flat mouth, pupils roll when animated and hold a pose when still', () => {
    const d = describeFlower(spec, 'annoyed', palette);
    expect(EMOTIONS.annoyed.mouth).toBe('flat');
    expect(d.rollVals.split(';').length).toBe(d.rollKeyTimes.split(';').length);
    expect(d.rollVals).not.toBe('');
    const still = describeFlower(spec, 'annoyed', palette, { animate: false });
    expect(still.rollVals).toBe('');
    expect(still.pupilD).toBe(d.pupilD);
    expect(flowerSvgString(d, 48)).toContain('keyTimes="0;0.1;0.2;0.3;0.4;0.5;1"');
    expect(flowerSvgString(still, 48)).not.toContain('animate');
    for (const emo of EMOTION_IDS)
      if (emo !== 'annoyed') expect(describeFlower(spec, emo, palette).rollVals).toBe('');
  });
});

describe('stumped emotion', () => {
  const spec = generateCursorSpec(5);
  it('renders with asymmetric brows and a slanted mouth', () => {
    const n = describeFlower(spec, 'neutral', palette);
    const d = describeFlower(spec, 'stumped', palette);
    expect(d.emotion).toBe('stumped');
    expect(d.browsD).not.toBe('');
    expect(d.browsD).not.toBe(n.browsD);
    expect(d.mouthD).not.toBe(n.mouthD);
    expect(d.badge.glyph).toBe('?');
    expect(JSON.stringify(d)).not.toMatch(/NaN|undefined/);
  });
  it('tilts the sway around a rotated pose, only for stumped', () => {
    expect(describeFlower(spec, 'stumped', palette).swayVals).toBe('14 0 0;4 0 0;14 0 0');
    for (const emo of EMOTION_IDS) {
      if (emo === 'stumped') continue;
      expect(EMOTIONS[emo].tilt ?? 0).toBe(0);
      const a = EMOTIONS[emo].sway[0];
      expect(describeFlower(spec, emo, palette).swayVals).toBe(`${a} 0 0;${-a} 0 0;${a} 0 0`);
    }
  });
  it('is the error status face and stays svg-safe', () => {
    expect(STATUS_EMOTION.error).toBe('stumped');
    expect(EMOTIONS.worried).toBeDefined();
    const svg = flowerSvgString(describeFlower(spec, 'stumped', palette), 48);
    expect(svg).not.toMatch(/<script|href|<style|style=|javascript|on\w+=|NaN|undefined/i);
  });
});
