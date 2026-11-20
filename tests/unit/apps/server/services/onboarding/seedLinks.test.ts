/**
 * resolveSeedLinks: an onboarding placeholder becomes the id the seed created,
 * keeping a heading it names, or its plain text when there is none; every
 * other link, a link to a heading of the same doc included, stays exactly as
 * written.
 */
import { NO_SEED_IDS, resolveSeedLinks, type SeedIds } from '@server/services/onboarding/seedLinks';

const IDS: SeedIds = {
  docs: { 'recommended-setup': 'doc-1111111111111-aaaaaaaaa' },
  folders: { start: 'container-1' },
  tables: { ideas: 'catalog-1' },
  threads: { patty: 'thread-1111111111111-bbbbbbbbb' },
};

describe('resolveSeedLinks', () => {
  it('turns each placeholder kind into the id the seed created', () => {
    expect(
      resolveSeedLinks(
        '[Setup](onboarding:recommended-setup) [Start](onboarding-folder:start) ' +
          '[Ideas](onboarding-table:ideas) [Onboarding](onboarding-thread:patty)',
        IDS
      )
    ).toBe(
      '[Setup](doc-1111111111111-aaaaaaaaa) [Start](container-1) ' +
        '[Ideas](table:catalog-1) [Onboarding](thread-1111111111111-bbbbbbbbb)'
    );
  });

  it('leaves a placeholder with no id as its plain text', () => {
    expect(resolveSeedLinks('See [Setup](onboarding:recommended-setup).', NO_SEED_IDS)).toBe(
      'See Setup.'
    );
    expect(
      resolveSeedLinks(
        'See [Setup › Summary](onboarding:recommended-setup#h=summary).',
        NO_SEED_IDS
      )
    ).toBe('See Setup › Summary.');
  });

  it("keeps a doc link's heading, and resolves a transclusion of a seeded doc", () => {
    expect(
      resolveSeedLinks(
        '[Setup › Summary](onboarding:recommended-setup#h=summary)\n\n![](onboarding:recommended-setup)',
        IDS
      )
    ).toBe(
      '[Setup › Summary](doc-1111111111111-aaaaaaaaa#h=summary)\n\n![](doc-1111111111111-aaaaaaaaa)'
    );
  });

  it('keeps links to headings of the same doc, and other links, as written', () => {
    const text =
      '- [Q1: What do you want? (pick any)](#h=q1-what-do-you-want-pick-any)\n' +
      '- [Next steps](#next-steps)\n' +
      '- [Issues](https://github.com/snaglet-org/snaglet/issues)';
    expect(resolveSeedLinks(text, IDS)).toBe(text);
    expect(resolveSeedLinks(text, NO_SEED_IDS)).toBe(text);
  });
});
