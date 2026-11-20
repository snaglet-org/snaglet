import { describe, expect, it } from '@jest/globals';
import {
  helperThreadContentExclusionSql,
  helperThreadExclusionSql,
  hiddenThreadRowSql,
  visibleThreadRowSql,
} from '@snaglet/db/tables/threads/visibility';

describe('thread visibility SQL', () => {
  it('visibleThreadRowSql excludes helper and DM threads', () => {
    expect(visibleThreadRowSql('t')).toBe(
      "t.parent_thread_id IS NULL AND t.kind IS DISTINCT FROM 'dm'"
    );
  });

  it('helperThreadExclusionSql excludes DM threads as well as helpers', () => {
    const sql = helperThreadExclusionSql('n.id');
    expect(sql).toContain('snaglet_ht.parent_thread_id IS NOT NULL');
    expect(sql).toContain("snaglet_ht.kind = 'dm'");
  });

  it('hiddenThreadRowSql is the one helper-or-DM predicate the exclusion fragments use', () => {
    expect(hiddenThreadRowSql('t')).toBe("(t.parent_thread_id IS NOT NULL OR t.kind = 'dm')");
    expect(helperThreadExclusionSql('n.id')).toContain(hiddenThreadRowSql('snaglet_ht'));
  });

  it('helperThreadContentExclusionSql inherits the DM exclusion', () => {
    expect(helperThreadContentExclusionSql('n.id')).toContain("snaglet_ht.kind = 'dm'");
  });
});
