import { z } from 'zod';

/** Input schemas the doc(op) handlers validate (get, update, delete). */
export const WorkspaceGetDocInput = z
  .object({
    doc_id: z.string().optional(),
    doc_path: z.string().optional(),
    raw: z.boolean().optional().default(false),
    include_archived: z.boolean().optional().default(false),
  })
  .refine((data) => data.doc_id || data.doc_path, {
    message: 'Either doc_id or doc_path must be provided',
  })
  .refine((data) => !(data.doc_id && data.doc_path), {
    message: 'Cannot specify both doc_id and doc_path',
  });

export type WorkspaceGetDocInput = z.infer<typeof WorkspaceGetDocInput>;

export const WorkspaceEditDocInput = z.object({
  doc_id: z.string().optional().describe('Direct document ID to edit'),
  doc_path: z
    .string()
    .optional()
    .describe('Human-readable path to document (e.g., "/Projects/overview")'),
  edits: z
    .array(
      z.object({
        old_text: z
          .string()
          .describe(
            'Text to find. To write initial content into an empty document, pass an empty string; empty old_text is rejected once the document has content'
          ),
        new_text: z.string().describe('Replacement text (empty string = delete)'),
        context_before: z
          .string()
          .optional()
          .describe(
            'Text expected to appear immediately BEFORE old_text — used to disambiguate when old_text appears multiple times'
          ),
        context_after: z
          .string()
          .optional()
          .describe(
            'Text expected to appear immediately AFTER old_text — used to disambiguate when old_text appears multiple times'
          ),
        occurrence: z
          .number()
          .int()
          .optional()
          .describe('Which occurrence to replace (1-indexed, -1 = all occurrences)'),
      })
    )
    .describe(
      'Find/replace operations. To write initial content into an empty document, use [{old_text: "", new_text: "..."}]'
    )
    .min(1, 'At least one edit is required'),
  validate_only: z
    .boolean()
    .optional()
    .default(false)
    .describe('Preview changes without applying (default: false)'),
  create_backup: z
    .boolean()
    .optional()
    .default(true)
    .describe('Create backup before editing (default: true)'),
  allow_archived: z
    .boolean()
    .optional()
    .default(false)
    .describe('Allow editing an archived document (default: false)'),
  raw: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Match old_text against the stored source only, not the doc as read with its transclusions shown (default: false)'
    ),
});

export const WorkspaceDeleteDocInput = z.object({
  doc_id: z
    .string()
    .optional()
    .describe('The ID of the doc to delete. Either doc_id or doc_path must be provided.'),
  doc_path: z
    .string()
    .optional()
    .describe('Human-readable path to the doc. Either doc_id or doc_path must be provided.'),
  force: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'If false (default), the delete is refused while other docs transclude or link to this one. ' +
        'If true, the delete proceeds and those docs are listed in the response.'
    ),
  dry_run: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'If true, report what WOULD happen (docs that transclude or link to it, snapshot count) without deleting.'
    ),
});
