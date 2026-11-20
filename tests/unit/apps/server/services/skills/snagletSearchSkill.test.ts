/**
 * snaglet-search built-in skill: valid SKILL.md (its size is checked with every
 * built-in in promptSkillReferences.test.ts), and every
 * search `kind`, `kinds` value, mode and parameter it teaches exists in the
 * real search tool, so the skill cannot drift from the tool.
 */
import path from 'path';
import { describe, expect, it } from '@jest/globals';
import { SKILL_DESCRIPTION_MAX_CHARS, readSkillFolder } from '@server/services/skills/skillFile';
import searchDefinition from '@server/services/ToolService/tools/workspace/search/definition';
import { readFileSync } from 'fs';

const DIR = path.resolve(__dirname, '../../../../../../apps/server/builtin-skills');
const body = readFileSync(path.join(DIR, 'snaglet-search', 'SKILL.md'), 'utf8');

type Schema = { properties?: Record<string, { enum?: string[]; items?: { enum?: string[] } }> };
const input = searchDefinition.parameters_schema as unknown as Schema;
const unlisted = (searchDefinition as unknown as { unlisted_params?: Schema['properties'] })
  .unlisted_params;
const props = { ...(input.properties ?? {}), ...(unlisted ?? {}) };

describe('snaglet-search skill', () => {
  it('is a valid built-in skill within the description limit', async () => {
    const parsed = await readSkillFolder(DIR, 'snaglet-search');
    expect(parsed.error ?? null).toBeNull();
    expect(parsed.status).toBe('valid');
    expect(parsed.description.length).toBeLessThanOrEqual(SKILL_DESCRIPTION_MAX_CHARS);
  });

  it('only names kind values the search tool accepts', () => {
    const kinds = new Set(props.kind?.enum ?? []);
    for (const m of body.matchAll(/kind: "([a-z_]+)"/g)) expect(kinds).toContain(m[1]);
  });

  it('only names kinds[] values the search tool accepts', () => {
    const kinds = new Set(props.kinds?.items?.enum ?? []);
    for (const m of body.matchAll(/kinds: \[([^\]]*)\]/g)) {
      for (const v of m[1].matchAll(/"([a-z_]+)"/g)) expect(kinds).toContain(v[1]);
    }
  });

  it('only names modes the search tool accepts', () => {
    const modes = new Set(props.mode?.enum ?? []);
    for (const m of body.matchAll(/mode: "([a-z_]+)"/g)) {
      // `mode: "message_context"` belongs to the thread tool, not search.
      if (m[1] === 'message_context' || m[1] === 'find') continue;
      expect(modes).toContain(m[1]);
    }
  });

  it('teaches outline-then-read, what a link is, part-of-doc links and transclusion in one line', () => {
    const description = /^description: (.*)$/m.exec(body)?.[1] ?? '';
    expect(description).toContain('before you read a long doc');
    expect(description).toContain('to link to part of a doc');
    // Written against the planned doc op outline: level, text, line, anchor.
    expect(body).toContain('`doc` op `outline`');
    for (const field of ['`level`', '`text`', '`line`', '`anchor`']) expect(body).toContain(field);
    // The anchor is the whole fragment outline returns, level pin or repeat suffix included.
    expect(body).toContain('`#h=usage-1` or `#h3=setup`');
    expect(body).toContain('read or link only the section you need');
    expect(body).toContain(
      'shows the user a clickable reference they can preview or open in a pane'
    );
    expect(body).toContain('to transclude the doc (show its content in place)');
    // Named once, with a pointer to where the mechanics live; not explained here.
    expect(body.match(/transclu/g)).toHaveLength(2);
    // The mechanics live in the doc tool's description, which every agent with
    // the tool has; the prompt's Transclusions paragraph only some do.
    expect(body).toContain("the `doc` tool's description says how a transclusion behaves");
  });

  it('only names search parameters that exist', () => {
    const named = [
      'detail',
      'content_range',
      'time_range',
      'sort',
      'scope_files',
      'project_scope',
      'include_archived',
      'graph_depth',
      'filters',
      'table',
      'ids',
      'id',
      'limit',
    ];
    for (const p of named) expect(props).toHaveProperty(p);
  });
});
