import { describe, expect, it } from '@jest/globals';
import type { SkillMode, SkillRegistryRow } from '@snaglet/db';
import { resolveEffectiveSkills } from '@server/services/skills/resolveEffectiveSkills';

function skill(id: string, extra: Partial<SkillRegistryRow> = {}): SkillRegistryRow {
  return {
    id,
    scope: 'personal',
    projectId: null,
    slug: id,
    name: id,
    description: '',
    sourcePath: `/s/${id}`,
    contentHash: 'h',
    status: 'valid',
    error: null,
    indexedAt: '',
    createdAt: '',
    updatedAt: '',
    ...extra,
  };
}

const registry = new Map(
  [skill('a'), skill('b'), skill('c'), skill('bad', { status: 'invalid', error: 'too long' })].map(
    (s) => [s.id, s]
  )
);

const ids = (xs: string[]) => xs.map((skillId) => ({ skillId }));

function run(mode: SkillMode, general: string[], thread: string[]) {
  const r = resolveEffectiveSkills({
    mode,
    general: ids(general),
    thread: ids(thread),
    registry,
  });
  return {
    effective: r.effective.map((e) => `${e.skill.id}:${e.origin}`),
    dropped: r.dropped.map((d) => `${d.skillId}:${d.reason}`),
  };
}

describe('resolveEffectiveSkills — mode truth table', () => {
  it('inherit uses general defaults and ignores thread picks', () => {
    expect(run('inherit', ['a', 'b'], ['c']).effective).toEqual(['a:general', 'b:general']);
  });

  it('add unions general then thread picks', () => {
    expect(run('add', ['a'], ['c']).effective).toEqual(['a:general', 'c:thread']);
  });

  it('add dedupes a skill in both lists, keeping origin general', () => {
    expect(run('add', ['a', 'b'], ['b', 'c']).effective).toEqual([
      'a:general',
      'b:general',
      'c:thread',
    ]);
  });

  it('override uses thread picks only', () => {
    expect(run('override', ['a', 'b'], ['c']).effective).toEqual(['c:thread']);
  });

  it('an empty override means no skills, even with general defaults', () => {
    expect(run('override', ['a', 'b'], [])).toEqual({ effective: [], dropped: [] });
  });

  it('no assignments anywhere resolves to nothing in every mode', () => {
    for (const m of ['inherit', 'add', 'override'] as const) {
      expect(run(m, [], [])).toEqual({ effective: [], dropped: [] });
    }
  });
});

describe('resolveEffectiveSkills — drops with reasons', () => {
  it('drops invalid skills and ids with no registry row', () => {
    // A vanished folder deletes its row, so a stale id is just 'unknown'.
    expect(run('add', ['a', 'bad'], ['gone', 'nope'])).toEqual({
      effective: ['a:general'],
      dropped: ['bad:invalid', 'gone:unknown', 'nope:unknown'],
    });
  });

  it('skills are not per-project: the resolver takes no project input', () => {
    // Every valid skill is available in every thread, in any project.
    expect(run('inherit', ['a'], []).effective).toEqual(['a:general']);
  });

  it('a duplicate that is dropped is reported once', () => {
    expect(run('add', ['bad'], ['bad']).dropped).toEqual(['bad:invalid']);
  });

  it('preserves assignment order within each origin', () => {
    expect(run('add', ['c', 'a'], ['b']).effective).toEqual(['c:general', 'a:general', 'b:thread']);
  });
});

describe('resolveEffectiveSkills: built-in skills', () => {
  const builtin = (slug: string, extra: Partial<SkillRegistryRow> = {}) =>
    skill(`b-${slug}`, { scope: 'builtin', slug, ...extra });
  const runWith = (
    mode: SkillMode,
    general: string[],
    thread: string[],
    builtins: SkillRegistryRow[]
  ) =>
    resolveEffectiveSkills({
      mode,
      general: ids(general),
      thread: ids(thread),
      registry,
      builtin: builtins,
    }).effective.map((e) => `${e.skill.slug}:${e.origin}`);

  it.each<SkillMode>(['inherit', 'add', 'override'])(
    'every mode gets the built-ins, after the assigned skills (%s)',
    (mode) => {
      const out = runWith(mode, ['a'], ['b'], [builtin('snaglet-sdk')]);
      expect(out[out.length - 1]).toBe('snaglet-sdk:builtin');
    }
  );

  it('nothing assigned: the built-ins alone, in the order given', () => {
    expect(runWith('inherit', [], [], [builtin('snaglet-x'), builtin('snaglet-y')])).toEqual([
      'snaglet-x:builtin',
      'snaglet-y:builtin',
    ]);
  });

  it("an assigned skill with the same slug overrides the built-in (the user's copy wins)", () => {
    expect(runWith('inherit', ['a'], [], [builtin('a'), builtin('snaglet-z')])).toEqual([
      'a:general',
      'snaglet-z:builtin',
    ]);
  });

  it('a leftover assignment of a built-in is skipped: not effective as assigned, not dropped', () => {
    const snaglet = builtin('snaglet-search');
    const withBuiltin = new Map([...registry, [snaglet.id, snaglet]]);
    const resolve = (builtins: SkillRegistryRow[]) =>
      resolveEffectiveSkills({
        mode: 'add',
        general: ids([snaglet.id, 'a']),
        thread: ids([snaglet.id]),
        registry: withBuiltin,
        builtin: builtins,
      });
    // Still effective, once, through the built-in list (every agent has it).
    const r = resolve([snaglet]);
    expect(r.effective.map((e) => `${e.skill.slug}:${e.origin}`)).toEqual([
      'a:general',
      'snaglet-search:builtin',
    ]);
    expect(r.dropped).toEqual([]);
    // Settings (no built-in list) never shows it as an assigned skill.
    expect(resolve([]).effective.map((e) => e.skill.slug)).toEqual(['a']);
  });

  it('a personal override wins even when the built-in was assigned first', () => {
    const snaglet = builtin('shared');
    const mine = skill('mine', { slug: 'shared' });
    const r = resolveEffectiveSkills({
      mode: 'add',
      general: ids([snaglet.id]),
      thread: ids([mine.id]),
      registry: new Map([
        [snaglet.id, snaglet],
        [mine.id, mine],
      ]),
      builtin: [snaglet],
    });
    expect(r.effective.map((e) => `${e.skill.id}:${e.origin}`)).toEqual(['mine:thread']);
  });

  it('drops an invalid built-in without reporting it as a dropped assignment', () => {
    const r = resolveEffectiveSkills({
      mode: 'inherit',
      general: [],
      thread: [],
      registry,
      builtin: [builtin('broken', { status: 'invalid', error: 'no name' })],
    });
    expect(r.effective).toEqual([]);
    expect(r.dropped).toEqual([]);
  });
});
