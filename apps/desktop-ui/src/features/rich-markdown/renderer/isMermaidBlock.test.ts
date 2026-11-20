import { describe, expect, it } from 'vitest';
import { isMermaidBlock } from './isMermaidBlock';

describe('Mermaid code block recognition', () => {
  it.each([null, undefined, '', 'flowchart', 'graph'])(
    'recognizes flowchart syntax under %s',
    (label) => {
      expect(isMermaidBlock(label, 'flowchart TD\n A-->B')).toBe(true);
      expect(isMermaidBlock(label, '\n%% a comment\ngraph LR; A-->B')).toBe(true);
    }
  );

  it('retains explicit Mermaid fences, including invalid or unfinished syntax', () => {
    expect(isMermaidBlock('Mermaid', '')).toBe(true);
    expect(isMermaidBlock('mermaid', 'sequenceDiagram\n Alice->>Bob: Hi')).toBe(true);
  });

  it('does not reinterpret ordinary code or prose', () => {
    expect(isMermaidBlock('javascript', 'graph LR; A-->B')).toBe(false);
    expect(isMermaidBlock('', 'A -> B')).toBe(false);
    expect(isMermaidBlock('', 'a flowchart TD example')).toBe(false);
    expect(isMermaidBlock('mermaidjs-notes', 'graph LR; A-->B')).toBe(false);
  });
});
