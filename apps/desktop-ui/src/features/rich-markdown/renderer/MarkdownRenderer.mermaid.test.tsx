import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WHEEL_SCROLL_X_ATTR } from '@desktop/utils/horizontalWheelScroll';

/**
 * Mermaid fences go to <MermaidDiagram source=…/> instead of <pre><code>.
 * MermaidDiagram is mocked (it has its own tests); these pin the routing:
 * exact source text, no stray <pre>, other fences and inline code untouched,
 * several diagrams in one document.
 */
vi.mock('./MermaidDiagram', () => ({
  MermaidDiagram: ({ source }: { source: string }) => (
    <div data-testid="mermaid-diagram" data-source={source} />
  ),
}));

import { MarkdownRenderer } from './MarkdownRenderer';

const FLOW = 'graph TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]';
const SEQ = 'sequenceDiagram\n  Alice->>Bob: hi\n  Bob-->>Alice: hello';

function fence(lang: string, body: string): string {
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

function diagrams(): HTMLElement[] {
  return screen.queryAllByTestId('mermaid-diagram');
}

describe('MarkdownRenderer — fenced mermaid blocks', () => {
  it.each(['', 'flowchart', 'graph'])(
    'recognizes standard flowchart syntax in a %s fence',
    (language) => {
      render(<MarkdownRenderer content={fence(language, FLOW)} />);
      expect(diagrams()).toHaveLength(1);
      expect(diagrams()[0]).toHaveAttribute('data-source', FLOW);
    }
  );

  it('routes a ```mermaid fence to MermaidDiagram with the exact source (no trailing fence newline)', () => {
    const { container } = render(<MarkdownRenderer content={fence('mermaid', FLOW)} />);

    const found = diagrams();
    expect(found).toHaveLength(1);
    expect(found[0]).toHaveAttribute('data-source', FLOW);
    // The block must not also render as a code block.
    expect(container.querySelector('pre')).toBeNull();
    expect(container.querySelector('code.language-mermaid')).toBeNull();
    expect(container.textContent).not.toContain('graph TD');
  });

  it('leaves other fenced code as a <pre><code class="language-…"> wheel-scroll region', () => {
    const { container } = render(<MarkdownRenderer content={fence('ts', 'const answer = 42;')} />);

    expect(diagrams()).toHaveLength(0);
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre).toHaveAttribute(WHEEL_SCROLL_X_ATTR);
    const code = pre!.querySelector('code');
    expect(code).toHaveClass('language-ts');
    expect(code).toHaveTextContent('const answer = 42;');
  });

  it('leaves an unlabeled fence and inline code untouched', () => {
    const { container } = render(
      <MarkdownRenderer content={`Say \`mermaid\` inline.\n\n${fence('', 'plain block')}`} />
    );

    expect(diagrams()).toHaveLength(0);
    // Inline: a bare <code> with no <pre> parent and no language class.
    const inline = Array.from(container.querySelectorAll('code')).find(
      (el) => el.textContent === 'mermaid'
    );
    expect(inline).toBeDefined();
    expect(inline!.closest('pre')).toBeNull();
    expect(inline!.className).toBe('');
    // Unlabeled block: still a plain code block.
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain('plain block');
  });

  it('renders every mermaid block in a document, in order, and keeps the prose between them', () => {
    const content = [
      '# Plan',
      fence('mermaid', FLOW),
      'Then the handshake:',
      fence('mermaid', SEQ),
      fence('json', '{"ok":true}'),
    ].join('\n\n');
    const { container } = render(<MarkdownRenderer content={content} />);

    const found = diagrams();
    expect(found).toHaveLength(2);
    expect(found[0]).toHaveAttribute('data-source', FLOW);
    expect(found[1]).toHaveAttribute('data-source', SEQ);
    expect(container.querySelector('h1')).toHaveTextContent('Plan');
    expect(container.textContent).toContain('Then the handshake:');
    // Only the JSON fence remains a code block.
    const pres = container.querySelectorAll('pre');
    expect(pres).toHaveLength(1);
    expect(pres[0].querySelector('code')).toHaveClass('language-json');
    // Document order: diagram 1, prose, diagram 2, code.
    expect(
      found[0].compareDocumentPosition(found[1]) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      found[1].compareDocumentPosition(pres[0]) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('does not treat a language that merely starts with "mermaid" as a diagram', () => {
    const { container } = render(
      <MarkdownRenderer content={fence('mermaidjs-notes', 'not a diagram')} />
    );

    expect(diagrams()).toHaveLength(0);
    expect(container.querySelector('pre code')).toHaveClass('language-mermaidjs-notes');
  });

  it('hands table, row and agent links in a chart to MermaidDiagram verbatim, never as prose chips', () => {
    const chart = [
      'graph TD',
      '  A["[Reading list](table:table-1111111111111-aaaaaaaaa)"] --> B',
      '  B["[Fix login](entry:table-1111111111111-aaaaaaaaa/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee)"] --> C',
      '  C["[Test Agent A](agent:test-agent-a)"] --> D[[Test Agent A](test-agent-a)]',
    ].join('\n');
    const { container } = render(<MarkdownRenderer content={fence('mermaid', chart)} />);

    expect(diagrams()).toHaveLength(1);
    expect(diagrams()[0]).toHaveAttribute('data-source', chart);
    expect(container.querySelector('.md-chip')).toBeNull();
  });

  it('passes an empty diagram through as an empty source rather than crashing', () => {
    render(<MarkdownRenderer content={'```mermaid\n```'} />);

    const found = diagrams();
    expect(found).toHaveLength(1);
    expect(found[0]).toHaveAttribute('data-source', '');
  });
});
