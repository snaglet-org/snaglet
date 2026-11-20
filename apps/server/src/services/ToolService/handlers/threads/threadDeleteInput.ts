import { z } from 'zod';

const ThreadDeleteInput = z.object({
  thread_id: z.string().describe('ID of the thread to permanently delete.'),
  project_id: z
    .string()
    .optional()
    .describe(
      'Optional project scope. When provided the thread must be scoped to this project (its project_id) or the call is rejected; a flat thread never matches.'
    ),
  confirm: z
    .literal(true)
    .describe('Must be explicitly set to true. Prevents accidental deletion.'),
});

export type ThreadDeleteInputType = z.infer<typeof ThreadDeleteInput>;
