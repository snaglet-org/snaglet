import type { ToolHandler } from '@server/services/ToolService/types';
import dateTime from '@server/services/ToolService/handlers/trivial/dateTime';
import getCurrentDatetime from '@server/services/ToolService/handlers/trivial/getCurrentDatetime';

const tool: ToolHandler = async (input, settings, context) =>
  input.compat === 'date_time'
    ? dateTime(input, settings, context)
    : getCurrentDatetime(input, settings, context);

export default tool;
