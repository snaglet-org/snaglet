import type { ToolHandler } from '@server/services/ToolService/types';
import paneLayout from '@server/services/ToolService/handlers/workspace/paneLayout';
import navigatePane from '@server/services/ToolService/handlers/workspace/navigatePane';

type Input = Record<string, unknown>;

/** navigate's fields; layout takes none, so any of these on layout is refused. */
export const PANE_NAVIGATE_FIELDS = ['pane_key', 'mode', 'split_zone', 'new_pane_ratio', 'target'];

const strip = (input: Input): Input => {
  const { op: _op, ...rest } = input;
  return rest;
};

/**
 * pane(op): one core tool over the two pane handlers, layout and navigate.
 */
const tool: ToolHandler = async (input, settings, context) => {
  const op = typeof input.op === 'string' ? input.op : undefined;
  if (op === 'layout') {
    const foreign = PANE_NAVIGATE_FIELDS.filter((f) => input[f] !== undefined);
    if (foreign.length) {
      throw new Error(
        `pane layout: \`${foreign[0]}\` belongs to op navigate, not layout. Nothing was changed.`
      );
    }
    return paneLayout(strip(input), settings, context);
  }
  if (op === 'navigate') return navigatePane(strip(input), settings, context);
  throw new Error('op is required and must be one of layout | navigate.');
};

export default tool;
