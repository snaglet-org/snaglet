import { defaultCursorSpec } from '@snaglet/shared/cursor';
import { defaultWorkspaceColors } from '@snaglet/shared/constants/workspaceTheme';
import {
  buildAvatarDataUrl,
  buildAvatarDataUrls,
} from '@server/services/BrowserController/avatarSvg';

const PREFIX = 'data:image/svg+xml;base64,';
const decode = (u: string) => Buffer.from(u.slice(PREFIX.length), 'base64').toString('utf8');

describe('buildAvatarDataUrl', () => {
  const spec = defaultCursorSpec('test-agent-a');

  it('returns a safe base64 SVG data URL', () => {
    const url = buildAvatarDataUrl(spec, defaultWorkspaceColors);
    expect(url?.startsWith(PREFIX)).toBe(true);
    const svg = decode(url as string);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).not.toMatch(/<script|href|foreignObject/i);
    expect(svg.length).toBeLessThan(12 * 1024);
  });
  it('is stable for the same inputs and changes with the spec or palette', () => {
    const a = buildAvatarDataUrl(spec, defaultWorkspaceColors);
    expect(buildAvatarDataUrl(spec, { ...defaultWorkspaceColors })).toBe(a);
    const other = buildAvatarDataUrl(defaultCursorSpec('test-agent-b'), defaultWorkspaceColors);
    expect(other).not.toBe(a);
    const themed = buildAvatarDataUrl(spec, {
      ...defaultWorkspaceColors,
      [spec.colors.petal]: '#123456',
    });
    expect(themed).not.toBe(a);
  });
  it('never throws on a bad spec', () => {
    expect(() => buildAvatarDataUrl(null as never, defaultWorkspaceColors)).not.toThrow();
    expect(buildAvatarDataUrl(null as never, defaultWorkspaceColors)).toBeUndefined();
  });
});

describe('buildAvatarDataUrls', () => {
  const spec = defaultCursorSpec('test-agent-c');
  it('returns safe neutral and stumped faces that differ, cached by identity', () => {
    const a = buildAvatarDataUrls(spec, defaultWorkspaceColors);
    expect(a?.neutral?.startsWith(PREFIX)).toBe(true);
    expect(a?.stumped?.startsWith(PREFIX)).toBe(true);
    expect(a?.stumped).not.toBe(a?.neutral);
    for (const u of [a?.neutral, a?.stumped]) {
      expect(decode(u as string)).not.toMatch(/<script|href|foreignObject/i);
    }
    expect(buildAvatarDataUrls(spec, { ...defaultWorkspaceColors })).toBe(a);
    expect(buildAvatarDataUrl(spec, defaultWorkspaceColors)).toBe(a?.neutral);
  });
  it('returns all four faces, each distinct and safe', () => {
    const a = buildAvatarDataUrls(spec, defaultWorkspaceColors);
    const faces = [a?.neutral, a?.stumped, a?.thinking, a?.curious] as string[];
    for (const u of faces) {
      expect(u?.startsWith(PREFIX)).toBe(true);
      const svg = decode(u);
      expect(svg).not.toMatch(/<script|href|foreignObject/i);
      expect(svg.length).toBeLessThan(12 * 1024);
    }
    expect(new Set(faces).size).toBe(4);
  });
  it('never throws on a bad spec', () => {
    expect(buildAvatarDataUrls(null as never, defaultWorkspaceColors)).toBeUndefined();
  });
});
