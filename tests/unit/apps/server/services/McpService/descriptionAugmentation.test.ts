/** Unit test for McpService's Snaglet-side description augmentation step (pure function). */

import { augmentMcpDescription, mcpService } from '@server/services/McpService/McpService';

describe('augmentMcpDescription', () => {
  it('passes descriptions through untouched (no augmentations are registered)', () => {
    const original = 'Take a screenshot.';
    expect(augmentMcpDescription('some-server', 'browser_take_screenshot', original)).toBe(
      original
    );
    expect(augmentMcpDescription('some-server', 'browser_navigate', '')).toBe('');
  });
});

describe('MCP confirmation policy', () => {
  it('fails safe for an unknown or not-yet-loaded server', () => {
    expect(mcpService.getConfirmationPolicy('missing-test-server')).toBe(true);
  });
});
