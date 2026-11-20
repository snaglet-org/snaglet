/**
 * Tools whose rarer fields left the advertised schema to save tokens on every
 * turn (`unlisted_params`; search and thread have their own tests). The
 * handlers read input directly and nothing validates it against
 * parameters_schema, so an unlisted field keeps working; these tests pin that
 * each one stays discoverable: its schema in unlisted_params (returned by
 * tool op:schema), its name in TOOL.md, and a pointer in the description.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { BuiltinToolDefinition } from '@server/services/ToolService/types';
import agent from '@server/services/ToolService/tools/agents/agent/definition';
import mcp from '@server/services/ToolService/tools/agents/mcp/definition';
import subagent from '@server/services/ToolService/tools/agents/subagent/definition';
import automation from '@server/services/ToolService/tools/automations/automation/definition';
import calendar from '@server/services/ToolService/tools/calendar/calendar/definition';
import table from '@server/services/ToolService/tools/tables/table/definition';
import doc from '@server/services/ToolService/tools/docs/doc/definition';
import hook from '@server/services/ToolService/tools/hooks/hook/definition';
import node from '@server/services/ToolService/tools/workspace/node/definition';

const TOOLS_DIR = path.resolve(
  __dirname,
  '../../../../../../../apps/server/src/services/ToolService/tools'
);

const TRIMMED: Array<[string, BuiltinToolDefinition, string]> = [
  ['agent', agent, 'agents/agent'],
  ['mcp', mcp, 'agents/mcp'],
  ['subagent', subagent, 'agents/subagent'],
  ['automation', automation, 'automations/automation'],
  ['calendar', calendar, 'calendar/calendar'],
  ['table', table, 'tables/table'],
  ['doc', doc, 'docs/doc'],
  ['hook', hook, 'hooks/hook'],
  ['node', node, 'workspace/node'],
];

/**
 * What a first call needs that the hidden schemas would otherwise hold: the
 * description names it, so the call succeeds without a tool op:schema first.
 */
const FIRST_CALL: Record<string, string[]> = {
  calendar: ['set_reminders (before:["15m","1d"], at_start, sound, enabled, clear:true)'],
  doc: [
    'restore (snapshot_id',
    'delete-snapshot (snapshot_id',
    'category:"project" makes a project',
  ],
  table: [
    'create {fields:[{name, type: text|number|date|datetime|checkbox|relation|select,',
    '{op:"add_field", field}',
    '{op:"update_field", name, set:{field props}}',
  ],
};

describe('descriptions carry what a first call of a trimmed op needs', () => {
  it.each(Object.entries(FIRST_CALL))('%s', (id, phrases) => {
    const definition = TRIMMED.find(([toolId]) => toolId === id)![1];
    for (const phrase of phrases) expect(definition.description).toContain(phrase);
  });
});

describe.each(TRIMMED)('%s unlisted params', (id, definition, folder) => {
  const listed = (definition.parameters_schema.properties ?? {}) as Record<string, unknown>;
  const unlisted = definition.unlisted_params ?? {};
  const toolMd = readFileSync(path.join(TOOLS_DIR, folder, 'TOOL.md'), 'utf8');

  it('has unlisted fields, none of them also listed', () => {
    expect(definition.id).toBe(id);
    expect(Object.keys(unlisted).length).toBeGreaterThan(0);
    for (const field of Object.keys(unlisted)) expect(listed).not.toHaveProperty(field);
  });

  it('keeps a typed, described schema for each one', () => {
    for (const [field, schema] of Object.entries(unlisted)) {
      expect({ field, typed: 'type' in schema || 'enum' in schema }).toEqual({
        field,
        typed: true,
      });
      expect(schema.description).toEqual(expect.any(String));
    }
  });

  it('names each one in TOOL.md', () => {
    for (const field of Object.keys(unlisted)) expect(toolMd).toContain(`\`${field}\``);
    expect(toolMd).toContain(`tool({op: "schema", name: "${id}"})`);
  });

  it('points at tool op:schema from the description', () => {
    expect(definition.description).toContain(`tool({op:"schema", name:"${id}"})`);
    expect(definition.description).toContain('unlisted_parameters');
  });
});
