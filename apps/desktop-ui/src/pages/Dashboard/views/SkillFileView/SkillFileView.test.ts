import { describe, expect, it } from 'vitest';
import { splitFrontmatter } from './SkillFileView';

describe('splitFrontmatter', () => {
  it('strips a leading frontmatter block', () => {
    const r = splitFrontmatter('---\nname: A\ndescription: B\n---\n# Body\n');
    expect(r).toEqual({ frontmatter: 'name: A\ndescription: B', body: '# Body\n' });
  });

  it('leaves text without frontmatter alone, including a later ---', () => {
    const text = '# Title\n\n---\nnot: frontmatter\n---\n';
    expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
  });
});
