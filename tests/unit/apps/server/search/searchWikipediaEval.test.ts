import { describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { scoreQuery } from '../../../../support/searchEval/metrics';
import {
  loadWikipediaFixtures,
  effectiveWikipediaInput,
  wikipediaDocumentBody,
  parseWikipediaOutput,
  assertWikipediaScope,
} from '../../../../support/searchEval/wikipedia/contract';

// Breaks caught: corrupt provenance/evidence, mode leakage, metadata forwarded as
// tool arguments, rank laundering by filtering hits, and silent scope leakage.
// These tests intentionally precede the new pure contract module.
const root = path.resolve(__dirname, '../../../../support/searchEval/wikipedia');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const scope = {
  parentId: 'container-eval-parent',
  projectIds: new Map([
    ['physical-sciences', 'container-physical'],
    ['living-systems', 'container-living'],
    ['arts-and-technology', 'container-arts'],
  ]),
};

function fixtureQuery(id: string) {
  const query = loadWikipediaFixtures().queries.find((item) => item.id === id);
  if (!query) throw new Error(`Missing fixture ${id}`);
  return query;
}

describe('Wikipedia evaluation fixture contract', () => {
  it('loads a self-contained attributed corpus with exact evidence and preserved source hashes', () => {
    const { corpus, queries } = loadWikipediaFixtures();
    expect(corpus.documents).toHaveLength(8);
    expect(corpus.projects).toHaveLength(3);
    expect(queries).toHaveLength(36);
    expect(new Set(queries.map((query) => query.id)).size).toBe(36);
    expect(new Set(corpus.documents.map((doc) => doc.key)).size).toBe(8);
    expect(corpus.containerPlan.title).toBe('Search eval corpus');
    expect(sha256(readFileSync(path.join(root, 'source-response.json'), 'utf8'))).toBe(
      corpus.sourceResponseSha256
    );
    const categories: Record<string, number> = {};
    for (const doc of corpus.documents) {
      expect(corpus.projects.some((project) => project.key === doc.projectKey)).toBe(true);
      expect(sha256(doc.content)).toBe(doc.source.excerptSha256);
      expect(doc.source.revisionId).toBeGreaterThan(0);
      expect(doc.source.permalink).toContain(`oldid=${doc.source.revisionId}`);
      expect(doc.attributionNote).toContain(doc.source.url);
      expect(doc.attributionNote).toContain('Wikipedia contributors');
      expect(doc.attributionNote).toContain('https://creativecommons.org/licenses/by-sa/4.0/');
      expect(doc.attributionNote).toContain(doc.source.adaptation);
      expect(wikipediaDocumentBody(doc)).toBe(`${doc.content}\n\n${doc.attributionNote}`);
    }
    for (const query of queries) {
      categories[query.category] = (categories[query.category] ?? 0) + 1;
      expect(query.expected.length).toBeGreaterThan(0);
      expect(query.rationale.length).toBeGreaterThan(0);
      for (const key of query.expected) {
        const doc = corpus.documents.find((item) => item.key === key);
        expect(doc).toBeDefined();
        if (query.scope) expect(doc?.projectKey).toBe(query.scope.projectKey);
        expect(query.evidence.some((evidence) => evidence.docKey === key)).toBe(true);
      }
      for (const evidence of query.evidence) {
        const doc = corpus.documents.find((item) => item.key === evidence.docKey);
        expect(doc?.content.slice(evidence.startOffset, evidence.endOffset)).toBe(evidence.text);
      }
    }
    expect(categories).toEqual({
      'exact/title': 8,
      keyword: 8,
      paraphrase: 8,
      'ambiguous/disambiguated': 4,
      'cross-topic distractor': 4,
      'scope filter': 4,
    });
  });

  it.each([
    ['keyword-baseline', 'keyword'],
    ['mocked-hybrid-pipeline', 'hybrid'],
    ['real-embeddings-hybrid', 'hybrid'],
  ] as const)(
    'overrides every authored mode in %s without mutating static fixtures',
    (mode, expectedMode) => {
      const { queries } = loadWikipediaFixtures();
      const before = JSON.stringify(queries);
      for (const query of queries) {
        const input = effectiveWikipediaInput(query, mode, scope);
        expect(input.mode).toBe(expectedMode);
        expect(input.kind).toBe('workspace');
        expect(input.kinds).toEqual(['doc']);
        expect(input.limit).toBe(10);
        expect(input.query).toBe(query.input.query);
        expect(Object.keys(input).sort()).toEqual([
          'container_id',
          'kind',
          'kinds',
          'limit',
          'mode',
          'query',
        ]);
      }
      expect(JSON.stringify(queries)).toBe(before);
    }
  );

  it.each([
    ['wikipedia-01', 'container-eval-parent'],
    ['wikipedia-33', 'container-physical'],
    ['wikipedia-34', 'container-living'],
    ['wikipedia-35', 'container-arts'],
    ['wikipedia-36', 'container-arts'],
  ])('resolves %s to explicit workspace subtree %s', (id, containerId) => {
    expect(effectiveWikipediaInput(fixtureQuery(id), 'keyword-baseline', scope).container_id).toBe(
      containerId
    );
  });

  it('rejects an unknown project rather than broadening the query to the parent', () => {
    const query = { ...fixtureQuery('wikipedia-33'), scope: { projectKey: 'missing-project' } };
    expect(() => effectiveWikipediaInput(query, 'keyword-baseline', scope)).toThrow(
      /project|scope/i
    );
  });
});

describe('Wikipedia rendered result contract', () => {
  const ids = new Map([
    ['planet-id', 'mercury-planet'],
    ['element-id', 'mercury-element'],
    ['pollination-id', 'pollination'],
  ]);
  const projects = new Map([
    ['mercury-planet', 'physical-sciences'],
    ['mercury-element', 'physical-sciences'],
    ['pollination', 'living-systems'],
  ]);

  it('parses parenthesized titles, preserves order/duplicates/unknowns and ignores snippet links', () => {
    const output = [
      '📄 [Mercury (planet)](doc:doc-planet-id)',
      '  Source: [Wikipedia](https://en.wikipedia.org/wiki/Mercury_(planet))',
      '  Related: [Mercury (element)](doc:doc-element-id)',
      '📄 [Outside fixture](doc:doc-unknown-id)',
      '📄 [Mercury (element)](doc:doc-element-id)',
      '📄 [Mercury (planet)](doc:doc-planet-id)',
    ].join('\n');
    expect(parseWikipediaOutput(output, ids)).toEqual([
      'mercury-planet',
      'unknown-id',
      'mercury-element',
      'mercury-planet',
    ]);
  });

  it.each(['', 'Error: database unavailable', 'Unexpected renderer payload', '{"error":"failed"}'])(
    'rejects malformed/error output instead of assigning zero recall: %j',
    (output) => {
      expect(() => parseWikipediaOutput(output, ids)).toThrow();
    }
  );

  it('accepts legitimate empty output and records zero recall rather than a quality failure', () => {
    expect(parseWikipediaOutput('No results found.', ids)).toEqual([]);
    expect(parseWikipediaOutput('No results for "nearest star".', ids)).toEqual([]);
    expect(() => assertWikipediaScope([], undefined, projects)).not.toThrow();
    expect(scoreQuery([], ['mercury-planet'], 5).recallAt5).toBe(0);
  });

  it('rejects project leakage even when all expected results rank first', () => {
    const hits = ['mercury-planet', 'mercury-element', 'pollination'];
    expect(scoreQuery(hits, ['mercury-planet', 'mercury-element'], 10).recallAt5).toBe(1);
    expect(() => assertWikipediaScope(hits, 'physical-sciences', projects)).toThrow(/scope/i);
    expect(() => assertWikipediaScope(hits, undefined, projects)).not.toThrow();
  });

  it('rejects unknown hits even for a parent-scoped query', () => {
    expect(() => assertWikipediaScope(['unknown-id'], undefined, projects)).toThrow(
      /unknown|scope/i
    );
  });

  it.each([
    [['mercury-planet'], 0.5, 1],
    [['mercury-element', 'mercury-planet'], 1, 1],
    [['pollination', 'mercury-planet', 'mercury-planet'], 0.5, 0.5],
    [['mercury-planet', 'x', 'y', 'z', 'w', 'mercury-element'], 0.5, 1],
  ] as Array<[string[], number, number]>)(
    'scores multi-relevant displayed hits %j without choosing a winner',
    (hits, recallAt5, reciprocalRank) => {
      expect(scoreQuery(hits, ['mercury-planet', 'mercury-element'], 10)).toMatchObject({
        recallAt5,
        reciprocalRank,
      });
    }
  );
});
