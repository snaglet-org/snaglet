import {
  workspaceColorResetPatch,
  workspaceColorTokens,
} from '@snaglet/shared/constants/workspaceTheme';

describe('workspaceColorResetPatch', () => {
  it('removes every saved color when no tokens are named', () => {
    expect(workspaceColorResetPatch()).toEqual(
      Object.fromEntries(workspaceColorTokens.map((token) => [token.name, null]))
    );
  });

  it('removes only the named tokens and refuses a name that is not a token', () => {
    expect(workspaceColorResetPatch(['detail'])).toEqual({ detail: null });
    expect(() => workspaceColorResetPatch(['detail', 'nope'])).toThrow(
      'Unknown theme tokens: nope'
    );
  });
});

describe('workspace color token descriptions', () => {
  // The Theme view prints each one under its color, and change_color_theme
  // sends every one in its schema, so they stay short and name what is painted.
  it.each(workspaceColorTokens.map((token) => [token.name, token.description]))(
    '%s says in a sentence or two what it colors',
    (_name, description) => {
      expect(description).toMatch(/^[A-Z].*\.$/);
      expect(description).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(description.split(/\s+/).length).toBeLessThanOrEqual(30);
    }
  );

  it('gives every token its own description', () => {
    const descriptions = workspaceColorTokens.map((token) => token.description);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });
});
