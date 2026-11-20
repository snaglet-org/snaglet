import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLOWER_GRIP } from '@snaglet/shared/constants/agentCursor';

const files = [
  '../AgentCursorApproval/AgentCursorApproval.css',
  './AgentCursorOverlay.css',
  './ClarificationCard.css',
];

describe('agent cursor CSS follows the workspace theme', () => {
  for (const file of files) {
    const css = readFileSync(resolve(__dirname, file), 'utf8');
    it(`${file} has no color literals or invented variables`, () => {
      expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(css).not.toMatch(/\brgba?\(/i);
      expect(css).not.toMatch(/\bhsla?\(/i);
      expect(css).not.toMatch(/--color-surface|--color-text/);
    });
  }
});

describe('agent cursor sits beside the real arrow, not on it', () => {
  const css = readFileSync(resolve(__dirname, './AgentCursorOverlay.css'), 'utf8');

  it('offsets the avatar up and to the left of the click point', () => {
    expect(css).toMatch(/--snaglet-cursor-offset:\s*\d+px/);
    expect(css).toMatch(
      /transform:\s*translate\(\s*calc\(-40px - var\(--snaglet-cursor-offset\)\),\s*calc\(-40px - var\(--snaglet-cursor-offset\)\)\s*\)/
    );
  });

  it('keeps the name tag above the avatar, away from the arrow, and shows all of its text', () => {
    const tag = /\.snaglet-agent-cursor__tag\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(tag).toMatch(/bottom:\s*calc\(100% \+ \d+px\)/);
    expect(tag).toMatch(/left:\s*0/);
    // It wraps instead of being cut off, so the whole reason is readable.
    expect(tag).toMatch(/white-space:\s*normal/);
    expect(tag).not.toMatch(/text-overflow/);
    expect(tag).not.toMatch(/overflow:\s*hidden/);
    expect(tag).not.toMatch(/white-space:\s*nowrap/);
  });

  it('the grip the server mirrors (FLOWER_GRIP) starts where the drawn avatar does', () => {
    const offset = Number(/--snaglet-cursor-offset:\s*(\d+)px/.exec(css)?.[1]);
    expect(FLOWER_GRIP.left).toBe(-(40 + offset));
    expect(FLOWER_GRIP.top).toBe(-(40 + offset));
    expect(FLOWER_GRIP.right - FLOWER_GRIP.left).toBe(80);
    // It stops short of the click point.
    expect(FLOWER_GRIP.bottom).toBeLessThan(0);
  });

  it('centers the click ring on the click point, not on the avatar', () => {
    const ring = /\.snaglet-agent-cursor__ring\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(ring).toContain('var(--snaglet-cursor-offset)');
  });
});

describe('cursor approval card uses the theme accent, not black and white', () => {
  const css = readFileSync(
    resolve(__dirname, '../AgentCursorApproval/AgentCursorApproval.css'),
    'utf8'
  );
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf('}', at));
  };

  it('fills the allow button and the countdown bar with the accent', () => {
    expect(rule('.snaglet-cursor-approval__actions button:first-child')).toMatch(
      /background:\s*var\(--detail\)/
    );
    expect(rule('.snaglet-cursor-approval__barfill')).toMatch(/background:\s*var\(--detail\)/);
  });

  it('sits on the raised surface with an accent edge', () => {
    const card = rule('.snaglet-cursor-approval__card');
    expect(card).toMatch(/background:\s*var\(--raised\)/);
    expect(card).toMatch(/border-top:\s*3px solid var\(--detail\)/);
    expect(card).toMatch(
      /border-left:\s*4px solid var\(--snaglet-cursor-agent-color, var\(--agent\)\)/
    );
  });
});
