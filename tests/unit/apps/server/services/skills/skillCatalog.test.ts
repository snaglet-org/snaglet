/**
 * renderSkillCatalog: deterministic bytes, null when empty,
 * lists every skill up to a high safety cap, then one overflow line.
 */
jest.mock('@snaglet/db', () => ({ SkillAssignments: {}, SkillRegistry: {}, Threads: {} }));

import {
  renderSkillCatalog,
  SKILL_CATALOG_HEADER,
  SKILL_CATALOG_MAX_ENTRIES,
  type SkillCatalogEntry,
} from '@server/services/skills/skillCatalog';

const entry = (slug: string, over: Partial<SkillCatalogEntry> = {}): SkillCatalogEntry => ({
  slug,
  description: `Does ${slug}.`,
  ...over,
});

describe('renderSkillCatalog', () => {
  it('returns null for an empty set', () => {
    expect(renderSkillCatalog([])).toBeNull();
  });

  it('same bytes regardless of input order; sorted by slug', () => {
    const set = [entry('triage'), entry('alpha'), entry('delta'), entry('beta')];
    const a = renderSkillCatalog(set)!;
    const b = renderSkillCatalog([...set].reverse())!;
    const c = renderSkillCatalog([set[2]!, set[0]!, set[3]!, set[1]!])!;
    expect(b).toBe(a);
    expect(c).toBe(a);
    const lines = a.split('\n').slice(SKILL_CATALOG_HEADER.split('\n').length);
    expect(lines).toEqual([
      '- `alpha` — Does alpha.',
      '- `beta` — Does beta.',
      '- `delta` — Does delta.',
      '- `triage` — Does triage.',
    ]);
  });

  it('carries no ids, hashes or timestamps — only slug and description', () => {
    const text = renderSkillCatalog([entry('alpha')])!;
    expect(text.startsWith(SKILL_CATALOG_HEADER)).toBe(true);
    expect(text).not.toMatch(/[0-9a-f]{12,}/);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('collapses whitespace in descriptions to one line per entry', () => {
    const text = renderSkillCatalog([
      entry('alpha', { description: 'Line one.\n\n  Line   two.' }),
    ])!;
    expect(text).toContain('- `alpha` — Line one. Line two.');
  });

  it('lists all 30 skills with long descriptions, sorted, with no overflow line', () => {
    const long = 'd'.repeat(290);
    const many = Array.from({ length: 30 }, (_, i) =>
      entry(`s${String(i).padStart(2, '0')}`, { description: long })
    );
    const text = renderSkillCatalog([...many].reverse())!;
    const lines = text.split('\n').filter((l) => l.startsWith('- `'));
    expect(lines).toHaveLength(30);
    expect(lines[0]).toContain('`s00`');
    expect(lines[29]).toContain('`s29`');
    expect(lines.every((l) => l.endsWith(long))).toBe(true);
    expect(text).not.toMatch(/more not listed/);
    expect(text.length).toBeGreaterThan(2048);
  });

  it('a single entry renders the header and one line', () => {
    expect(renderSkillCatalog([entry('alpha')])).toBe(
      `${SKILL_CATALOG_HEADER}\n- \`alpha\` — Does alpha.`
    );
  });

  it('no overflow line when everything fits', () => {
    const text = renderSkillCatalog([entry('a'), entry('b')])!;
    expect(text).not.toContain('more not listed');
  });

  it('stops at the safety cap with one overflow line naming how many are hidden', () => {
    const total = SKILL_CATALOG_MAX_ENTRIES + 5;
    const many = Array.from({ length: total }, (_, i) => entry(`s${String(i).padStart(3, '0')}`));
    const text = renderSkillCatalog([...many].reverse())!;
    const lines = text.split('\n').filter((l) => l.startsWith('- `'));
    expect(lines).toHaveLength(SKILL_CATALOG_MAX_ENTRIES);
    expect(lines[0]).toContain('`s000`');
    expect(text.split('\n').at(-1)).toContain('+5 more not listed');
  });
});
