import type { ToolHandler } from '@server/services/ToolService/types';
import shellRun from '../shellRun';
import shellWrite from '../shellWrite';

const OPS: Record<string, ToolHandler> = {
  run: shellRun,
  write: shellWrite,
};

const present = (value: unknown): boolean => value !== undefined && value !== null;

/**
 * Fields each op ignores. A call carrying one is refused, so what the
 * permission guard reads (cmd/command) can never differ from what runs.
 */
const FOREIGN_FIELDS: Record<string, string[]> = {
  run: ['chars', 'session_id'],
  write: ['cmd', 'command'],
};

/** shell(op): run a command, or write to / poll a still-running one. */
const tool: ToolHandler = async (input, settings, context) => {
  const op = typeof input.op === 'string' ? input.op : undefined;
  const handler = op === undefined ? undefined : OPS[op];
  if (op === undefined || !handler) {
    throw new Error(`op is required and must be one of ${Object.keys(OPS).join(' | ')}.`);
  }
  const foreign = (FOREIGN_FIELDS[op] ?? []).filter((f) => present(input[f]));
  if (foreign.length > 0) {
    throw new Error(
      input.op === 'run'
        ? `run takes no ${foreign.map((f) => `\`${f}\``).join(' or ')}; use op:"write" to send input to a running session.`
        : `write takes no ${foreign.map((f) => `\`${f}\``).join(' or ')}; use op:"run" to start a command.`
    );
  }
  return handler(input, settings, context);
};

export default tool;
