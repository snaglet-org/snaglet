import { getErrorMessage } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { runAppleScript } from './runners';

const SCRIPT = [
  'on run argv',
  '  tell application "Messages"',
  '    try',
  '      set b to buddy (item 1 of argv) of (first service whose service type is iMessage)',
  '      return "true"',
  '    on error',
  '      return "false"',
  '    end try',
  '  end tell',
  'end run',
];

const handler: ToolHandler = async (params) => {
  const { contact } = params as { contact: string };

  if (!contact || typeof contact !== 'string') {
    return JSON.stringify({ error: 'Missing required parameter: contact' });
  }

  try {
    const stdout = await runAppleScript(SCRIPT, [contact]);
    const available = stdout.trim() === 'true';
    return JSON.stringify({
      contact,
      imessage_available: available,
      message: available
        ? `${contact} is registered with iMessage.`
        : `${contact} is not on iMessage \u2014 message will fall back to SMS.`,
    });
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    return JSON.stringify({
      error: `Failed to check iMessage availability: ${msg}`,
      detail:
        'Ensure Messages.app is open and signed in with an Apple ID. The Snaglet server may also need Automation access to Messages in System Settings \u2192 Privacy & Security.',
    });
  }
};

export default handler;
