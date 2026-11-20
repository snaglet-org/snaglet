import { getErrorMessage } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { runAppleScript } from './runners';

/** argv: recipient, body, service type ("iMessage" | "SMS"). */
const SCRIPT = [
  'on run argv',
  '  set recipient to item 1 of argv',
  '  set messageBody to item 2 of argv',
  '  tell application "Messages"',
  '    if (item 3 of argv) is "SMS" then',
  '      set targetService to first service whose service type is SMS',
  '    else',
  '      set targetService to first service whose service type is iMessage',
  '    end if',
  '    set targetBuddy to buddy recipient of targetService',
  '    send messageBody to targetBuddy',
  '  end tell',
  'end run',
];

const handler: ToolHandler = async (params) => {
  const {
    to,
    body,
    service = 'iMessage',
  } = params as {
    to: string;
    body: string;
    service?: 'iMessage' | 'SMS';
  };

  if (!to || typeof to !== 'string') {
    return JSON.stringify({ error: 'Missing required parameter: to' });
  }
  if (!body || typeof body !== 'string') {
    return JSON.stringify({ error: 'Missing required parameter: body' });
  }

  const serviceType = service === 'SMS' ? 'SMS' : 'iMessage';

  try {
    await runAppleScript(SCRIPT, [to, body, serviceType]);
    return JSON.stringify({
      success: true,
      to,
      service: serviceType,
      message: `Message sent to ${to} via ${serviceType}.`,
    });
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    return JSON.stringify({
      success: false,
      error: `Failed to send message: ${msg}`,
      detail:
        'Ensure Messages.app is open, signed in, and the Snaglet server process has Automation access to Messages in System Settings \u2192 Privacy & Security.',
    });
  }
};

export default handler;
