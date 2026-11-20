import { describe, expect, it } from '@jest/globals';
import {
  extractMarkdownRefs,
  extractMarkdownRefIds,
  extractNodeRefs,
  extractNodeRefIds,
  MARKDOWN_REF_REGEX,
} from '@server/services/WorkspaceService/markdownRefs';

describe('markdownRefs util', () => {
  describe('extractMarkdownRefs', () => {
    it('returns empty for empty/null content', () => {
      expect(extractMarkdownRefs('')).toEqual([]);
      expect(extractMarkdownRefs(undefined as unknown as string)).toEqual([]);
    });

    it('captures a single transclusion ref with label, id, index, length, kind', () => {
      const content = 'See ![Onboarding](doc-abc) for details.';
      const hits = extractMarkdownRefs(content);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        targetId: 'doc-abc',
        label: 'Onboarding',
        kind: 'transclusion',
      });
      expect(hits[0].index).toBe(content.indexOf('!['));
      expect(hits[0].length).toBe('![Onboarding](doc-abc)'.length);
    });

    it('captures a single plain-link ref with kind="link"', () => {
      const content = 'See [Onboarding](doc-abc) for details.';
      const hits = extractMarkdownRefs(content);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        targetId: 'doc-abc',
        label: 'Onboarding',
        kind: 'link',
      });
      expect(hits[0].index).toBe(content.indexOf('['));
      expect(hits[0].length).toBe('[Onboarding](doc-abc)'.length);
    });

    it('captures both transclusion and plain-link forms in one document', () => {
      const hits = extractMarkdownRefs('![A](doc-1) and [B](doc-2)');
      expect(hits.map((h) => h.targetId)).toEqual(['doc-1', 'doc-2']);
      expect(hits.map((h) => h.kind)).toEqual(['transclusion', 'link']);
      expect(hits.map((h) => h.label)).toEqual(['A', 'B']);
    });

    it('captures multiple refs and preserves order + duplicates', () => {
      const content = '![A](doc-1) and ![B](doc-2) and ![A again](doc-1).';
      const hits = extractMarkdownRefs(content);
      expect(hits.map((h) => h.targetId)).toEqual(['doc-1', 'doc-2', 'doc-1']);
      expect(hits.map((h) => h.label)).toEqual(['A', 'B', 'A again']);
      expect(hits.every((h) => h.kind === 'transclusion')).toBe(true);
    });

    it('captures refs with empty labels in both forms', () => {
      const hits = extractMarkdownRefs('![](doc-x) and [](doc-y)');
      expect(hits).toHaveLength(2);
      expect(hits[0]).toMatchObject({ targetId: 'doc-x', label: '', kind: 'transclusion' });
      expect(hits[1]).toMatchObject({ targetId: 'doc-y', label: '', kind: 'link' });
    });

    it('correctly distinguishes transclusion and link when adjacent', () => {
      // `![](doc-1)[](doc-2)` — the `!` belongs to the first only.
      const hits = extractMarkdownRefs('![](doc-1)[](doc-2)');
      expect(hits).toHaveLength(2);
      expect(hits[0].kind).toBe('transclusion');
      expect(hits[1].kind).toBe('link');
    });
  });

  describe('extractMarkdownRefIds', () => {
    it('returns deduped set of ids (across transclusion + link forms)', () => {
      const ids = extractMarkdownRefIds('![](doc-1) [](doc-1) ![](doc-2) [](doc-3)');
      expect(Array.from(ids).sort()).toEqual(['doc-1', 'doc-2', 'doc-3']);
    });
  });

  describe('extractNodeRefs', () => {
    it('keeps refs whose id matches a known node prefix (transclusion + link)', () => {
      const hits = extractNodeRefs('![](doc-1) [](container-2) ![](task-3) [](https://x)');
      expect(hits.map((h) => h.targetId)).toEqual(['doc-1', 'container-2', 'task-3']);
    });

    it('filters out arbitrary urls regardless of form', () => {
      const hits = extractNodeRefs(
        '![alt](https://example.com/x.png) ![](doc-1) [click](https://example.com)'
      );
      expect(hits.map((h) => h.targetId)).toEqual(['doc-1']);
    });
  });

  describe('extractNodeRefIds', () => {
    it('returns the deduped node-id set', () => {
      const ids = extractNodeRefIds('![](doc-1) [](https://x) ![](doc-1) [](task-2)');
      expect(Array.from(ids).sort()).toEqual(['doc-1', 'task-2']);
    });
  });

  describe('code-region masking (do not extract from code)', () => {
    it('ignores refs inside inline code spans (single backtick)', () => {
      const hits = extractMarkdownRefs('Use the syntax `![title](doc-id)` to transclude.');
      expect(hits).toEqual([]);
    });

    it('ignores refs inside inline code spans (multi-backtick)', () => {
      const hits = extractMarkdownRefs('Like ``![title](doc-id)`` in prose.');
      expect(hits).toEqual([]);
    });

    it('ignores refs inside fenced code blocks (```)', () => {
      const content = [
        'before',
        '```',
        '![Example](doc-abc)',
        '[Example](doc-def)',
        '```',
        'after ![Real](doc-real)',
      ].join('\n');
      const hits = extractMarkdownRefs(content);
      expect(hits.map((h) => h.targetId)).toEqual(['doc-real']);
    });

    it('ignores refs inside fenced code blocks with language tag', () => {
      const content = '```markdown\n![Example](doc-abc)\n```\n![Real](doc-real)';
      const hits = extractMarkdownRefs(content);
      expect(hits.map((h) => h.targetId)).toEqual(['doc-real']);
    });

    it('ignores refs inside ~~~ fenced blocks', () => {
      const content = '~~~\n![X](doc-x)\n~~~\n![Y](doc-y)';
      const hits = extractMarkdownRefs(content);
      expect(hits.map((h) => h.targetId)).toEqual(['doc-y']);
    });

    it('still extracts refs outside code regions in mixed content', () => {
      const content = [
        '# Heading',
        'Inline syntax: `![title](doc-id)` like that.',
        '',
        '![Actual](doc-real-1)',
        '',
        '```',
        '![Fake](doc-fake)',
        '```',
        '',
        '[Plain](doc-real-2)',
      ].join('\n');
      const hits = extractMarkdownRefs(content);
      expect(hits.map((h) => h.targetId)).toEqual(['doc-real-1', 'doc-real-2']);
    });

    it('preserves offsets when code regions are masked (rename relies on index)', () => {
      const content = '`![](doc-fake)` ![real](doc-real)';
      const hits = extractMarkdownRefs(content);
      expect(hits).toHaveLength(1);
      const hit = hits[0];
      // The real ref should start where "![real]..." starts in the original string.
      expect(content.slice(hit.index, hit.index + hit.length)).toBe('![real](doc-real)');
    });
  });

  describe('exported regexes', () => {
    it('MARKDOWN_REF_REGEX matches both transclusion and plain-link forms', () => {
      const re = new RegExp(MARKDOWN_REF_REGEX.source, 'g');
      const matches = [...'![a](doc-1) [b](doc-2)'.matchAll(re)];
      expect(matches).toHaveLength(2);
    });
  });
});

describe('markdownRefs util — doc line links', () => {
  it('strips the `#L…` fragment from targetId and reports the lines', () => {
    const [hit] = extractMarkdownRefs('[part](doc-1111111111111-aaaaaaaaa#L4-L9)');
    expect(hit).toMatchObject({
      targetId: 'doc-1111111111111-aaaaaaaaa',
      lines: { startLine: 4, endLine: 9 },
      kind: 'link',
    });
    expect(extractNodeRefIds('[a](doc-1111111111111-aaaaaaaaa#L1)')).toEqual(
      new Set(['doc-1111111111111-aaaaaaaaa'])
    );
  });
});
