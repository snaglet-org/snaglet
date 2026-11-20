import { z } from 'zod';

export const WorkspaceSnapshotDocInput = z.object({
  doc_id: z
    .string()
    .optional()
    .describe('The ID of the doc to snapshot. Either doc_id or doc_path must be provided.'),
  doc_path: z
    .string()
    .optional()
    .describe(
      'Human-readable path to the doc (e.g. "/Projects/Snaglet/plan"). Either doc_id or doc_path must be provided.'
    ),
  label: z
    .string()
    .max(120)
    .optional()
    .describe('Short label for this snapshot (e.g. "pre-refactor"). Searchable.'),
  reason: z
    .string()
    .max(1000)
    .optional()
    .describe('Free-form note explaining why the snapshot was taken.'),
  allow_archived: z
    .boolean()
    .optional()
    .default(false)
    .describe('Allow snapshotting an archived doc (default: false)'),
});

export const WorkspaceListSnapshotsInput = z.object({
  doc_id: z
    .string()
    .optional()
    .describe('Filter snapshots for a single doc by ID. Either doc_id or doc_path is required.'),
  doc_path: z
    .string()
    .optional()
    .describe('Filter snapshots for a single doc by path. Either doc_id or doc_path is required.'),
  label: z.string().optional().describe('Filter to snapshots with this exact label.'),
  limit: z.number().int().positive().max(200).optional().default(50),
  include_content: z.boolean().optional().default(false),
});
