import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'skill',
  name: 'Skill',
  description:
    "Load a skill available to you in this thread (see ## Skills). op: load (the skill's SKILL.md, by slug), read (one supporting file in the skill folder, by slug + relative path). A long file comes in numbered parts: each part but the last ends with the call for the next one (pass part). Grants no permissions.",
  type: 'builtin',
  tier: 'core',
  // Availability is the calling agent's effective set for the calling thread.
  contextRequirement: 'agent-required',
  keywords: ['skill', 'skills', 'playbook', 'load skill', 'how to', 'procedure', 'SKILL.md'],
  parameters_schema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['load', 'read'] },
      slug: { type: 'string', description: 'Skill slug as listed under ## Skills.' },
      path: {
        type: 'string',
        description: 'read: file path relative to the skill folder (e.g. "templates/pr.md").',
      },
      part: {
        type: 'integer',
        minimum: 1,
        description:
          'Which part of a long file to return, 1-based (default 1). Only needed when a result ends with "[Part N of M — call skill … for the next part]".',
      },
      version: {
        type: 'string',
        description:
          'The version from that footer, passed with part. If the file changed since, the call fails; start again from part 1.',
      },
    },
    required: ['op', 'slug'],
    additionalProperties: false,
  },
  sort_order: 31,
};

export default definition;
