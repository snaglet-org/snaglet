import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ToolHandler, ToolHandlerContext } from '@server/services/ToolService/types';

const gmailSend = jest.fn<ToolHandler>();
const driveSearchFiles = jest.fn<ToolHandler>();
const driveDeleteFile = jest.fn<ToolHandler>();
const calendarListEvents = jest.fn<ToolHandler>();
const docsRead = jest.fn<ToolHandler>();
const sheetsAppend = jest.fn<ToolHandler>();
const imessageSend = jest.fn<ToolHandler>();
const gitStatus = jest.fn<ToolHandler>();

jest.mock('@server/services/ToolService/handlers/integrations/google/gmail/send', () => ({
  __esModule: true,
  default: gmailSend,
}));
jest.mock('@server/services/ToolService/handlers/integrations/google/drive/searchFiles', () => ({
  __esModule: true,
  default: driveSearchFiles,
}));
jest.mock('@server/services/ToolService/handlers/integrations/google/drive/deleteFile', () => ({
  __esModule: true,
  default: driveDeleteFile,
}));
jest.mock('@server/services/ToolService/handlers/integrations/google/calendar/listEvents', () => ({
  __esModule: true,
  default: calendarListEvents,
}));
jest.mock('@server/services/ToolService/handlers/integrations/google/docs/read', () => ({
  __esModule: true,
  default: docsRead,
}));
jest.mock('@server/services/ToolService/handlers/integrations/google/sheets/append', () => ({
  __esModule: true,
  default: sheetsAppend,
}));
jest.mock('@server/services/ToolService/handlers/integrations/imessage/sendMessage', () => ({
  __esModule: true,
  default: imessageSend,
}));
jest.mock('@server/services/ToolService/handlers/integrations/git/status', () => ({
  __esModule: true,
  default: gitStatus,
}));

import { createCapabilityRouter } from '@server/services/ToolService/lib/capabilityRouter';
import googleGmail from '@server/services/ToolService/tools/integrations/google/google-gmail/tool';
import googleDrive from '@server/services/ToolService/tools/integrations/google/google-drive/tool';
import googleDriveAdmin from '@server/services/ToolService/tools/integrations/google/google-drive-admin/tool';
import googleCalendar from '@server/services/ToolService/tools/integrations/google/google-calendar/tool';
import googleDocs from '@server/services/ToolService/tools/integrations/google/google-docs/tool';
import googleSheets from '@server/services/ToolService/tools/integrations/google/google-sheets/tool';
import imessage from '@server/services/ToolService/tools/integrations/apple/imessage/tool';
import git from '@server/services/ToolService/tools/integrations/github/git/tool';
import gmailDefinition from '@server/services/ToolService/tools/integrations/google/google-gmail/definition';
import driveDefinition from '@server/services/ToolService/tools/integrations/google/google-drive/definition';
import driveAdminDefinition from '@server/services/ToolService/tools/integrations/google/google-drive-admin/definition';
import calendarDefinition from '@server/services/ToolService/tools/integrations/google/google-calendar/definition';
import docsDefinition from '@server/services/ToolService/tools/integrations/google/google-docs/definition';
import sheetsDefinition from '@server/services/ToolService/tools/integrations/google/google-sheets/definition';
import imessageDefinition from '@server/services/ToolService/tools/integrations/apple/imessage/definition';
import gitDefinition from '@server/services/ToolService/tools/integrations/github/git/definition';
import { resolveToolId, transformToolAliasParams } from '@snaglet/shared/utils';

const settings = { credential_id: 'credential-1' };
const context: ToolHandlerContext = {
  agentId: 'agent-1',
  threadId: 'thread-1',
  cwd: '/tmp/project',
};

describe('canonical integration capability routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    gmailSend.mockResolvedValue('gmail sent');
    driveSearchFiles.mockResolvedValue('drive searched');
    driveDeleteFile.mockResolvedValue('drive file deleted');
    calendarListEvents.mockResolvedValue('calendar events');
    docsRead.mockResolvedValue('doc read');
    sheetsAppend.mockResolvedValue('sheet appended');
    imessageSend.mockResolvedValue('message sent');
    gitStatus.mockResolvedValue('git status');
  });

  it.each([
    {
      label: 'google_gmail send',
      tool: googleGmail,
      input: {
        operation: 'send',
        to: 'person@example.com',
        subject: 'Hello',
        body: 'World',
      },
      forwarded: { to: 'person@example.com', subject: 'Hello', body: 'World' },
      handler: gmailSend,
    },
    {
      label: 'google_drive search_files',
      tool: googleDrive,
      input: { operation: 'search_files', query: 'roadmap' },
      forwarded: { query: 'roadmap' },
      handler: driveSearchFiles,
    },
    {
      label: 'google_drive_admin delete_file',
      tool: googleDriveAdmin,
      input: { operation: 'delete_file', fileId: 'file-1', permanent: false },
      forwarded: { fileId: 'file-1', permanent: false },
      handler: driveDeleteFile,
    },
    {
      label: 'google_calendar list_events',
      tool: googleCalendar,
      input: { operation: 'list_events', calendarId: 'primary' },
      forwarded: { calendarId: 'primary' },
      handler: calendarListEvents,
    },
    {
      label: 'google_docs read',
      tool: googleDocs,
      input: { operation: 'read', documentId: 'doc-1' },
      forwarded: { documentId: 'doc-1' },
      handler: docsRead,
    },
    {
      label: 'google_sheets append',
      tool: googleSheets,
      input: {
        operation: 'append',
        spreadsheetId: 'sheet-1',
        range: 'A1:B2',
        values: [['a', 'b']],
      },
      forwarded: {
        spreadsheetId: 'sheet-1',
        range: 'A1:B2',
        values: [['a', 'b']],
      },
      handler: sheetsAppend,
    },
    {
      label: 'imessage send',
      tool: imessage,
      input: { operation: 'send', to: '+15555550123', body: 'Hello' },
      forwarded: { to: '+15555550123', body: 'Hello' },
      handler: imessageSend,
    },
    {
      label: 'git status',
      tool: git,
      input: { subcommand: 'status', cwd: '/tmp/override' },
      forwarded: { cwd: '/tmp/override' },
      handler: gitStatus,
    },
  ])(
    'routes $label without forwarding its discriminator',
    async ({ tool, input, forwarded, handler }) => {
      await expect(tool(input, settings, context)).resolves.toEqual(expect.any(String));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(forwarded, settings, context);
    }
  );

  it('rejects a missing discriminator before invoking a handler', async () => {
    const handler = jest.fn<ToolHandler>();
    const router = createCapabilityRouter({ known: handler });

    await expect(router({ value: 1 }, settings, context)).rejects.toThrow('operation is required');
    expect(handler).not.toHaveBeenCalled();
  });

  it('routes an old Gmail id through the canonical mock-level smoke', async () => {
    const resolution = resolveToolId('google_gmail_send');
    const input = transformToolAliasParams(resolution, {
      to: 'person@example.com',
      subject: 'Alias smoke',
      body: 'Hello',
    });

    await expect(googleGmail(input, settings, context)).resolves.toBe('gmail sent');
    expect(gmailSend).toHaveBeenCalledWith(
      {
        to: 'person@example.com',
        subject: 'Alias smoke',
        body: 'Hello',
      },
      settings,
      context
    );
  });

  it('rejects an unknown discriminator with the available operations', async () => {
    const handler = jest.fn<ToolHandler>();
    const router = createCapabilityRouter({ known: handler });

    await expect(router({ operation: 'missing' }, settings, context)).rejects.toThrow(
      'Unsupported operation "missing". Expected one of: known'
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    gmailDefinition,
    driveDefinition,
    driveAdminDefinition,
    calendarDefinition,
    docsDefinition,
    sheetsDefinition,
    imessageDefinition,
    gitDefinition,
  ])('$id stays below the 1.5k-token capability-schema ceiling', (definition) => {
    const bytes = Buffer.byteLength(
      JSON.stringify({
        description: definition.description,
        parameters_schema: definition.parameters_schema,
      })
    );

    expect(bytes).toBeLessThanOrEqual(6_000);
  });
});
