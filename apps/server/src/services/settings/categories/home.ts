/**
 * `home` category settings: what the desktop Home pane keeps for each person.
 *
 * `pinned` maps a user id to that person's pins, keyed `<kind>:<id>`. It is
 * written one pin at a time through the settings entry routes
 * (`PUT/DELETE /api/settings/home/pinned/entries/<userId>/<kind>:<id>`), so a
 * pin from one window never drops a pin made in another. `title` is the name
 * the item had when it was pinned, shown only when the item itself can no
 * longer be found.
 */

import { z } from 'zod';
import { defineCategory } from '../defineSetting';

const PinnedItemSchema = z.object({
  kind: z.enum(['thread', 'doc', 'project', 'table']),
  id: z.string().min(1),
  title: z.string().max(500).optional(),
  pinnedAt: z.string().min(1),
});

const PinnedByUserSchema = z.record(z.string(), z.record(z.string(), PinnedItemSchema));

// Registered for the settings routes only; no server code reads it.
defineCategory('home', {
  pinned: {
    key: 'pinned',
    schema: PinnedByUserSchema,
    default: {} as z.infer<typeof PinnedByUserSchema>,
    description:
      "Items each person pinned to the Home pane, keyed by user id, then by '<kind>:<id>' " +
      '(kind is thread, doc, project or table): {kind, id, title, pinnedAt}.',
  },
});
