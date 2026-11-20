import { defaultWorkspaceColors } from '../constants/workspaceTheme';
import type { FlowerDescription } from './describe';

const PATH_RE = /^[MmLlQqCcTtAaZz0-9\s.,-]*$/;
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|(rgb|hsl)a?\([0-9a-zA-Z.,%\s/+-]*\))$/;
const VALUES_RE = /^[0-9\s.;-]*$/;
const DUR_RE = /^[0-9.]+s$/;
const FALLBACK_COLOR = defaultWorkspaceColors.agent!;

function num(v: number, fallback = 0): string {
  return Number.isFinite(v) ? String(Math.round(v * 1000) / 1000 + 0) : String(fallback);
}
function path(d: string): string {
  return PATH_RE.test(d) ? d : '';
}
function color(c: string): string {
  return COLOR_RE.test(c) ? c : FALLBACK_COLOR;
}
function values(v: string, fallback: string): string {
  return VALUES_RE.test(v) ? v : fallback;
}
function dur(v: string): string {
  return DUR_RE.test(v) ? v : '3s';
}
function escText(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`).slice(0, 4);
}
function viewBox(v: string): string {
  return /^-?[0-9.]+( -?[0-9.]+){3}$/.test(v) ? v : '-64 -66 128 132';
}

function anim(type: string, vals: string, d: string, keyTimes: string, splines: boolean): string {
  const base =
    `<animateTransform attributeName="transform" type="${type}" values="${vals}" keyTimes="${keyTimes}" ` +
    (splines ? `calcMode="spline" keySplines="0.4 0 0.6 1;0.4 0 0.6 1" ` : '') +
    `dur="${d}" repeatCount="indefinite"/>`;
  return base;
}

/**
 * Self-contained SVG for a FlowerDescription. Every number, color and path is
 * validated; no scripts, no external references, no style elements.
 */
export function flowerSvgString(desc: FlowerDescription, sizePx: number): string {
  const size = Number.isFinite(sizePx) ? Math.min(1024, Math.max(8, Math.round(sizePx))) : 56;
  const c = desc.colors;
  const sw = desc.strokeWidths;
  const animate = desc.animate;
  const K3 = '0;0.5;1';
  const wrap = (type: string, vals: string, d: string, inner: string, fb: string): string =>
    animate
      ? `<g>${anim(type, values(vals, fb), dur(d), K3, true)}${inner}</g>`
      : `<g>${inner}</g>`;

  const face =
    `<path d="${path(desc.ringD)}" fill="${color(c.ringFill)}" stroke="${color(c.ringStroke)}" stroke-width="${num(sw.ring)}" stroke-linejoin="round" opacity="${num(desc.ringOpacity)}"/>` +
    `<path d="${path(desc.petalsD)}" fill="${color(c.petalFill)}" stroke="${color(c.petalStroke)}" stroke-width="${num(sw.petal)}" stroke-linejoin="round"/>` +
    `<circle cx="0" cy="0" r="${num(desc.cr)}" fill="${color(c.centerFill)}" stroke="${color(c.centerStroke)}" stroke-width="${num(sw.center)}"/>` +
    `<circle cx="${num(desc.cheeks.lx)}" cy="${num(desc.cheeks.y)}" r="${num(desc.cheeks.r)}" fill="${color(c.cheek)}" opacity="${num(desc.cheeks.opacity)}"/>` +
    `<circle cx="${num(desc.cheeks.rx)}" cy="${num(desc.cheeks.y)}" r="${num(desc.cheeks.r)}" fill="${color(c.cheek)}" opacity="${num(desc.cheeks.opacity)}"/>` +
    `<path d="${path(desc.browsD)}" fill="none" stroke="${color(c.feature)}" stroke-width="${num(sw.face)}" stroke-linecap="round" opacity="${num(desc.browsOpacity)}"/>` +
    `<g transform="translate(0 ${num(desc.eyeY)})"><g>` +
    (animate
      ? anim(
          'scale',
          values(desc.blinkVals, '1 1;1 1;1 1;1 1'),
          dur(desc.blinkDur),
          '0;0.9;0.95;1',
          false
        )
      : '') +
    (animate && desc.rollVals
      ? `<g>${anim('translate', values(desc.rollVals, '0 0;0 0;0 0'), dur(desc.rollDur), desc.rollKeyTimes, false)}`
      : '<g>') +
    `<path d="${path(desc.pupilD)}" fill="${color(c.feature)}"/>` +
    `<path d="${path(desc.glintD)}" fill="${color(c.glint)}" opacity="${num(desc.glintOpacity)}"/>` +
    `</g>` +
    `<path d="${path(desc.arcD)}" fill="none" stroke="${color(c.feature)}" stroke-width="${num(sw.face)}" stroke-linecap="round" opacity="${num(desc.arcOpacity)}"/>` +
    `</g></g>` +
    `<path d="${path(desc.mouthD)}" fill="${c.mouthFill === 'none' ? 'none' : color(c.mouthFill)}" stroke="${color(c.feature)}" stroke-width="${num(sw.face)}" stroke-linecap="round" stroke-linejoin="round"/>`;

  const pulse = wrap('scale', desc.pulseVals, desc.pulseDur, face, '1;1;1');
  const sway = wrap('rotate', desc.swayVals, desc.swayDur, pulse, '0 0 0;0 0 0;0 0 0');
  const bounce = wrap(
    'translate',
    desc.bounceVals,
    desc.bounceDur,
    sway + badge(desc),
    '0 0;0 0;0 0'
  );

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox(desc.viewBox)}" width="${size}" height="${size}" ` +
    `role="img" aria-label="flower avatar" overflow="visible" opacity="${num(desc.opacity, 1)}">${bounce}</svg>`
  );
}

function badge(desc: FlowerDescription): string {
  const b = desc.badge;
  if (!b.glyph || b.r <= 0) return '';
  const c = desc.colors;
  return (
    `<circle cx="${num(b.x)}" cy="${num(b.y)}" r="${num(b.r)}" fill="${color(c.badgeFill)}" stroke="${color(c.badgeStroke)}" stroke-width="${num(desc.strokeWidths.badge)}"/>` +
    `<text x="${num(b.x)}" y="${num(b.y + 4.5)}" text-anchor="middle" font-family="sans-serif" font-weight="800" font-size="13" fill="${color(c.badgeText)}">${escText(b.glyph)}</text>`
  );
}
