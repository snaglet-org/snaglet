import { describe, expect, it } from 'vitest';
import { isMermaidPreviewDrop } from './mermaidDrag';

const uri =
  'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg id="snaglet-mermaid-12"></svg>');
const transfer = (values: Record<string, string | undefined>) => ({
  getData: (type: string) => values[type] ?? '',
});

describe('rendered Mermaid drop detection', () => {
  it.each(['text/plain', 'text/uri-list'])('recognizes the generated SVG as %s', (type) => {
    expect(isMermaidPreviewDrop(transfer({ [type]: uri }))).toBe(true);
  });

  it('recognizes browser image HTML without requiring our DOM marker', () => {
    expect(isMermaidPreviewDrop(transfer({ 'text/html': `<img src="${uri}">` }))).toBe(true);
  });

  it.each([
    { 'text/plain': 'flowchart TD\n  A --> B' },
    { 'text/plain': 'const diagram = "' + uri + '";' },
    { 'text/html': '<pre><code>graph TD; A-->B</code></pre>' },
    { 'text/html': '<img src="https://example.com/diagram.png">' },
    {
      'text/plain': 'data:image/svg+xml,' + encodeURIComponent('<svg id="external-diagram"></svg>'),
    },
    { 'text/html': '<img src="data:image/png;base64,AAAA">' },
    { 'application/x-snaglet-node-chip': '{"id":"doc-test"}' },
    {},
  ])('leaves ordinary code, image and file/chip drops alone: %j', (values) => {
    expect(isMermaidPreviewDrop(transfer(values))).toBe(false);
  });
});
