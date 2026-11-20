import type { ToolHandler } from '@server/services/ToolService/types';
import { loadSkill, readSkillFile } from '@server/services/skills/skillTool';

const OPS: Record<string, ToolHandler> = {
  load: (input, _settings, context) => loadSkill(input, context),
  read: (input, _settings, context) => readSkillFile(input, context),
};

/** skill(op): load an assigned skill or one of its supporting files. */
const tool: ToolHandler = async (input, settings, context) => {
  const handler = typeof input.op === 'string' ? OPS[input.op] : undefined;
  if (!handler) {
    throw new Error(`op is required and must be one of ${Object.keys(OPS).join(' | ')}.`);
  }
  return handler(input, settings, context);
};

export default tool;
