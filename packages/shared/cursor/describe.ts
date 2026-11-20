import { defaultWorkspaceColors } from '../constants/workspaceTheme';
import { contrastRatio, pickReadable } from './contrast';
import { EMOTIONS, type EmotionId } from './emotions';
import { CENTER_TOKENS } from './tokens';
import type { CursorSpec } from './types';

export interface FlowerDescription {
  viewBox: string;
  emotion: EmotionId;
  animate: boolean;
  opacity: number;
  petalsD: string;
  ringD: string;
  ring: boolean;
  ringOpacity: number;
  /** All resolved CSS color strings. */
  colors: {
    petalFill: string;
    petalStroke: string;
    ringFill: string;
    ringStroke: string;
    centerFill: string;
    centerStroke: string;
    cheek: string;
    feature: string;
    glint: string;
    mouthFill: string;
    badgeFill: string;
    badgeText: string;
    badgeStroke: string;
  };
  strokeWidths: { petal: number; ring: number; center: number; face: number; badge: number };
  cr: number;
  cheeks: { lx: number; rx: number; y: number; r: number; opacity: number };
  eyeY: number;
  browsD: string;
  browsOpacity: number;
  pupilD: string;
  glintD: string;
  glintOpacity: number;
  arcD: string;
  arcOpacity: number;
  mouthD: string;
  swayVals: string;
  swayDur: string;
  bounceVals: string;
  bounceDur: string;
  pulseVals: string;
  pulseDur: string;
  blinkVals: string;
  blinkDur: string;
  /** Pupil roll path (translate values, '' when still) with its key times and duration. */
  rollVals: string;
  rollKeyTimes: string;
  rollDur: string;
  badge: { glyph: string; r: number; x: number; y: number };
}

const SAFE_COLOR = /^(#[0-9a-fA-F]{3,8}|(rgb|hsl)a?\([0-9a-zA-Z.,%\s/+-]*\))$/;

/** The shipped default for a missing or unsafe palette entry (the Agent color for petals and the like). */
function fallbackFor(token: string): string {
  if (token === 'text') return defaultWorkspaceColors.text!;
  if (token === 'background') return defaultWorkspaceColors.background!;
  return defaultWorkspaceColors.agent!;
}

const f = (v: number): number => Math.round(v * 100) / 100 + 0;
const fs = (v: number): string => String(f(v));

function rot(x: number, y: number, a: number): [number, number] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

function petal(
  t: number,
  wid: number,
  b: number,
  pos: number,
  round: number,
  angle: number
): string {
  const h = t - b;
  const mid = b + h * pos;
  const tip = wid * (0.15 + 0.85 * round);
  const P = (x: number, y: number): string => {
    const r = rot(x, y, angle);
    return `${fs(r[0])} ${fs(r[1])}`;
  };
  const k = mid + (t - mid) * 0.6;
  return (
    `M ${P(0, -b)} C ${P(wid * 0.9, -b)} ${P(wid * 1.05, -(b + h * 0.35))} ${P(wid, -mid)} ` +
    `C ${P(wid, -k)} ${P(tip, -t)} ${P(0, -t)} ` +
    `C ${P(-tip, -t)} ${P(-wid, -k)} ${P(-wid, -mid)} ` +
    `C ${P(-wid * 1.05, -(b + h * 0.35))} ${P(-wid * 0.9, -b)} ${P(0, -b)} Z`
  );
}

const circ = (cx: number, cy: number, r: number): string =>
  `M ${fs(cx - r)} ${fs(cy)} a ${fs(r)} ${fs(r)} 0 1 0 ${fs(2 * r)} 0 a ${fs(r)} ${fs(r)} 0 1 0 ${fs(-2 * r)} 0 `;
const ell = (cx: number, cy: number, rx: number, ry: number): string =>
  `M ${fs(cx - rx)} ${fs(cy)} a ${fs(rx)} ${fs(ry)} 0 1 0 ${fs(2 * rx)} 0 a ${fs(rx)} ${fs(ry)} 0 1 0 ${fs(-2 * rx)} 0 `;

export function describeFlower(
  spec: CursorSpec,
  emotion: EmotionId,
  palette: Record<string, string>,
  opts: { animate?: boolean; crying?: boolean } = {}
): FlowerDescription {
  const animate = opts.animate !== false;
  const emoId: EmotionId = EMOTIONS[emotion] ? emotion : 'neutral';
  const e = opts.crying ? { ...EMOTIONS.worried, eyes: 'wide' as const } : EMOTIONS[emoId];
  const p = spec.shape;

  const resolve = (token: string): string => {
    const v = palette[token];
    return typeof v === 'string' && SAFE_COLOR.test(v.trim()) ? v.trim() : fallbackFor(token);
  };

  // color resolution + contrast guard
  const petalFill = resolve(spec.colors.petal);
  const ringFill = resolve(spec.colors.ring);
  let centerFill = resolve(spec.colors.center);
  if (contrastRatio(centerFill, petalFill) < 1.25) {
    const alt = CENTER_TOKENS.find((t) => contrastRatio(resolve(t), petalFill) >= 1.25);
    if (alt) {
      centerFill = resolve(alt);
    }
  }
  const featureWanted = resolve(spec.colors.feature);
  const feature =
    contrastRatio(featureWanted, centerFill) >= 4.5
      ? featureWanted
      : pickReadable([resolve('text'), resolve('background'), resolve('border')], centerFill, 4.5);
  const outline = resolve(spec.colors.outline);
  const outlineAlts = [
    resolve('text'),
    resolve('border'),
    resolve('background'),
    resolve('foreground'),
  ];
  const petalStroke =
    contrastRatio(outline, petalFill) >= 1.5 ? outline : pickReadable(outlineAlts, petalFill, 3);
  const ringStroke =
    contrastRatio(outline, ringFill) >= 1.5 ? outline : pickReadable(outlineAlts, ringFill, 3);
  const centerStroke =
    contrastRatio(outline, centerFill) >= 1.5 ? outline : pickReadable(outlineAlts, centerFill, 3);
  const cheekWanted = resolve(spec.colors.cheek);
  const cheekBase = e.cheekColor ?? cheekWanted;
  const cheek = e.cheekColor
    ? contrastRatio(cheekBase, centerFill) >= 1.25
      ? cheekBase
      : '#e8527a'
    : contrastRatio(cheekWanted, centerFill) >= 1.25
      ? cheekWanted
      : pickReadable(
          [
            resolve('detail'),
            resolve('detail-2'),
            resolve('color-node-thread'),
            resolve('selected'),
            resolve('text'),
          ],
          centerFill,
          1.25
        );
  const light = '#ffffff';
  const dark = '#111111';
  const readableOn = (bg: string): string =>
    contrastRatio(light, bg) >= contrastRatio(dark, bg) ? light : dark;
  const glint = readableOn(feature);
  const badgeFill = resolve('agent');
  const badgeText = readableOn(badgeFill);
  const badgeStroke = resolve('background');

  // geometry
  let petalsD = '';
  let ringD = '';
  for (let i = 0; i < p.n; i++) {
    const a = (2 * Math.PI * i) / p.n;
    petalsD += petal(p.t, p.w, p.b, p.pos, p.round, a) + ' ';
    if (p.ring)
      ringD +=
        petal(p.t * p.ringScale + p.cr * 0.2, p.w * 0.9, p.b, p.pos, p.round, a + Math.PI / p.n) +
        ' ';
  }

  const cr = p.cr;
  const ex = cr * p.eyeSpacing;
  const er = cr * p.eyeSize;
  const look = e.look || [0, 0];
  const lx = look[0] * er * 0.55;
  const ly = look[1] * er * 0.55;
  // Eye roll: pupils sweep from the side, over the top and across, then settle where `look` rests.
  const rollU = er * 0.55;
  const rollPts: Array<[number, number]> = [
    [-0.9, 0.3],
    [-0.8, -0.9],
    [0.3, -1.1],
    [0.9, -0.9],
  ];
  const rolls = animate && !!e.eyeRoll;
  const rollVals = rolls
    ? [
        [0, 0],
        ...rollPts.map(([x, y]): [number, number] => [x * rollU - lx, y * rollU - ly]),
        [0, 0],
        [0, 0],
      ]
        .map(([x, y]) => `${fs(x)} ${fs(y)}`)
        .join(';')
    : '';
  let pupilD = '';
  let glintD = '';
  let arcD = '';
  let glintOpacity = 0;
  let arcOpacity = 0;
  if (e.eyes === 'open' || e.eyes === 'wide') {
    const r = e.eyes === 'wide' ? er * 1.35 : er;
    pupilD = circ(-ex + lx, ly, r) + circ(ex + lx, ly, r);
    glintD =
      circ(-ex + lx - r * 0.3, ly - r * 0.3, r * 0.32) +
      circ(ex + lx - r * 0.3, ly - r * 0.3, r * 0.32);
    glintOpacity = 1;
  } else if (e.eyes === 'narrow') {
    pupilD = ell(-ex, 0, er * 1.15, er * 0.55) + ell(ex, 0, er * 1.15, er * 0.55);
  } else if (e.eyes === 'arc') {
    arcD =
      `M ${fs(-ex - er * 1.2)} ${fs(er * 0.5)} Q ${fs(-ex)} ${fs(-er * 1.1)} ${fs(-ex + er * 1.2)} ${fs(er * 0.5)} ` +
      `M ${fs(ex - er * 1.2)} ${fs(er * 0.5)} Q ${fs(ex)} ${fs(-er * 1.1)} ${fs(ex + er * 1.2)} ${fs(er * 0.5)}`;
    arcOpacity = 1;
  } else {
    arcD =
      `M ${fs(-ex - er * 1.2)} 0 Q ${fs(-ex)} ${fs(er * 0.9)} ${fs(-ex + er * 1.2)} 0 ` +
      `M ${fs(ex - er * 1.2)} 0 Q ${fs(ex)} ${fs(er * 0.9)} ${fs(ex + er * 1.2)} 0`;
    arcOpacity = 1;
  }
  const eyeY = -cr * 0.12;
  const by = eyeY - er * 2.1;
  let browsD = '';
  if (e.brows === 'up') {
    browsD =
      `M ${fs(-ex - er * 1.2)} ${fs(by + er * 0.4)} Q ${fs(-ex)} ${fs(by - er * 0.7)} ${fs(-ex + er * 1.2)} ${fs(by + er * 0.4)} ` +
      `M ${fs(ex - er * 1.2)} ${fs(by + er * 0.4)} Q ${fs(ex)} ${fs(by - er * 0.7)} ${fs(ex + er * 1.2)} ${fs(by + er * 0.4)}`;
  } else if (e.brows === 'flat') {
    browsD =
      `M ${fs(-ex - er * 1.2)} ${fs(by - er * 0.2)} L ${fs(-ex + er * 1.2)} ${fs(by + er * 0.35)} ` +
      `M ${fs(ex + er * 1.2)} ${fs(by - er * 0.2)} L ${fs(ex - er * 1.2)} ${fs(by + er * 0.35)}`;
  } else if (e.brows === 'worry') {
    browsD =
      `M ${fs(-ex - er * 1.2)} ${fs(by + er * 0.5)} L ${fs(-ex + er * 1.2)} ${fs(by - er * 0.5)} ` +
      `M ${fs(ex + er * 1.2)} ${fs(by + er * 0.5)} L ${fs(ex - er * 1.2)} ${fs(by - er * 0.5)}`;
  } else if (e.brows === 'angry') {
    // sharply angled: outer ends high, inner ends dragged down toward the nose
    browsD =
      `M ${fs(-ex - er * 1.3)} ${fs(by - er * 0.7)} L ${fs(-ex + er * 1.2)} ${fs(by + er * 0.9)} ` +
      `M ${fs(ex + er * 1.3)} ${fs(by - er * 0.7)} L ${fs(ex - er * 1.2)} ${fs(by + er * 0.9)}`;
  } else if (e.brows === 'stumped') {
    // left brow raised in an arc, right brow lowered and slanted down toward the nose
    browsD =
      `M ${fs(-ex - er * 1.2)} ${fs(by - er * 0.1)} Q ${fs(-ex)} ${fs(by - er * 1.3)} ${fs(-ex + er * 1.2)} ${fs(by - er * 0.1)} ` +
      `M ${fs(ex + er * 1.2)} ${fs(by + er * 0.2)} L ${fs(ex - er * 1.2)} ${fs(by + er * 0.75)}`;
  }

  const my = cr * 0.42;
  const mx = cr * 0.3;
  let mouthD = '';
  let mouthFill = 'none';
  switch (e.mouth) {
    case 'smile':
      mouthD = `M ${fs(-mx)} ${fs(my)} Q 0 ${fs(my + cr * 0.3)} ${fs(mx)} ${fs(my)}`;
      break;
    case 'grin':
      mouthD = `M ${fs(-mx * 1.25)} ${fs(my)} Q 0 ${fs(my + cr * 0.66)} ${fs(mx * 1.25)} ${fs(my)} Z`;
      mouthFill = readableOn(feature);
      break;
    case 'flat':
      mouthD = `M ${fs(-mx * 0.8)} ${fs(my + cr * 0.1)} L ${fs(mx * 0.8)} ${fs(my + cr * 0.1)}`;
      break;
    case 'o':
      mouthD = circ(0, my + cr * 0.14, cr * 0.1);
      mouthFill = feature;
      break;
    case 'open':
      mouthD = ell(0, my + cr * 0.12, cr * 0.18, cr * 0.2);
      mouthFill = feature;
      break;
    case 'small':
      mouthD = `M ${fs(-mx * 0.6)} ${fs(my)} Q 0 ${fs(my + cr * 0.14)} ${fs(mx * 0.6)} ${fs(my)}`;
      break;
    case 'wavy':
      mouthD =
        `M ${fs(-mx)} ${fs(my + cr * 0.1)} Q ${fs(-mx * 0.5)} ${fs(my - cr * 0.07)} 0 ${fs(my + cr * 0.1)} ` +
        `T ${fs(mx)} ${fs(my + cr * 0.1)}`;
      break;
    case 'frown':
      mouthD = `M ${fs(-mx)} ${fs(my + cr * 0.2)} Q 0 ${fs(my - cr * 0.22)} ${fs(mx)} ${fs(my + cr * 0.2)}`;
      break;
    case 'slant':
      mouthD =
        `M ${fs(-mx * 0.8)} ${fs(my + cr * 0.12)} Q ${fs(-mx * 0.3)} ${fs(my - cr * 0.06)} ${fs(mx * 0.05)} ${fs(my + cr * 0.08)} ` +
        `T ${fs(mx * 0.8)} ${fs(my - cr * 0.04)}`;
      break;
  }
  if (opts.crying)
    mouthD = `M ${fs(-mx)} ${fs(my + cr * 0.15)} Q 0 ${fs(my - cr * 0.4)} ${fs(mx)} ${fs(my + cr * 0.15)}`;
  // The grin's fill must not vanish into the mouth stroke or the face.
  if (e.mouth === 'grin' && contrastRatio(mouthFill, feature) < 3) mouthFill = centerFill;

  const blinks = e.eyes === 'open' || e.eyes === 'wide' || e.eyes === 'narrow';
  const sway = e.sway[0];
  const tilt = e.tilt ?? 0;
  const still = `${fs(tilt)} 0 0;${fs(tilt)} 0 0;${fs(tilt)} 0 0`;
  return {
    viewBox: '-64 -66 128 132',
    emotion: emoId,
    animate,
    opacity: e.opacity,
    petalsD: petalsD.trim(),
    ringD: ringD.trim(),
    ring: p.ring,
    ringOpacity: p.ring ? 1 : 0,
    colors: {
      petalFill,
      petalStroke,
      ringFill,
      ringStroke,
      centerFill,
      centerStroke,
      cheek,
      feature,
      glint,
      mouthFill,
      badgeFill,
      badgeText,
      badgeStroke,
    },
    strokeWidths: { petal: 2.2, ring: 2, center: 2.2, face: f(Math.max(1.6, cr * 0.1)), badge: 2 },
    cr: f(cr),
    cheeks: {
      lx: f(-cr * 0.64),
      rx: f(cr * 0.64),
      y: f(cr * 0.3),
      r: f(cr * 0.17 * (e.cheekScale ?? 1)),
      opacity: e.cheeks,
    },
    eyeY: f(eyeY),
    browsD,
    browsOpacity: browsD ? 1 : 0,
    pupilD,
    glintD,
    glintOpacity,
    arcD,
    arcOpacity,
    mouthD,
    swayVals: animate
      ? `${fs(tilt + sway)} 0 0;${fs(tilt - sway)} 0 0;${fs(tilt + sway)} 0 0`
      : still,
    swayDur: `${e.sway[1]}s`,
    bounceVals: !animate
      ? '0 0;0 0;0 0'
      : e.shake
        ? `${fs(-e.shake[0])} 0;${fs(e.shake[0])} 0;${fs(-e.shake[0])} 0`
        : `0 0;0 ${fs(-e.bounce[0])};0 0`,
    bounceDur: `${e.shake ? e.shake[1] : e.bounce[1]}s`,
    pulseVals: animate ? `1;${fs(1 + e.pulse[0])};1` : '1;1;1',
    pulseDur: `${e.pulse[1]}s`,
    blinkVals: animate && blinks ? '1 1;1 1;1 0.1;1 1' : '1 1;1 1;1 1;1 1',
    blinkDur: '4.6s',
    rollVals,
    rollKeyTimes: rolls ? '0;0.1;0.2;0.3;0.4;0.5;1' : '',
    rollDur: '3.2s',
    badge: { glyph: e.badge, r: e.badge ? 9 : 0, x: 36, y: -38 },
  };
}
