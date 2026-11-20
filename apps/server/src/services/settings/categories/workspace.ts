/**
 * `workspace` category settings: about the workspace this database holds.
 *
 * `id` names it. The server makes one before it serves a database that has
 * none (a new one, or one from before this setting), and a new one after
 * every reset to a clean slate and every snapshot restore
 * (services/workspaceId.ts). A desktop window stamps it on the pane layout it
 * saves and does not restore a layout saved for another id, so a reset never
 * reopens panes on content that is gone.
 */

import { z } from 'zod';
import { defineCategory } from '../defineSetting';

export const workspaceSettings = defineCategory('workspace', {
  id: {
    key: 'id',
    schema: z.string().min(1).nullable(),
    default: null,
    description:
      'Internal: the id of the workspace this database holds. New on a new database and after ' +
      'every reset or restore, so a window does not reopen panes saved for other content.',
  },
});
