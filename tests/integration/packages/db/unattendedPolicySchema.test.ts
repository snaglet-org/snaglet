/**
 * The unattended policy on automations and hook registrations: a NOT NULL
 * column that defaults to 'skip' and takes only 'skip' and
 * 'auto-approve-allowed'.
 */
import { describe, expect, it } from '@jest/globals';
import { createFreshDatabase } from '../../../support/freshDatabase';

const HOOK = 'test-hook';

interface ColumnRow {
  table_name: string;
  is_nullable: string;
  column_default: string | null;
}

describe('unattended policy schema', () => {
  it('defaults to skip and takes only the known policies', async () => {
    const { db, close } = await createFreshDatabase('unattended');
    try {
      const { rows: columns } = await db.query<ColumnRow>(
        `SELECT table_name, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'unattended_policy'
          ORDER BY table_name`
      );
      expect(columns).toEqual([
        { table_name: 'automations', is_nullable: 'NO', column_default: "'skip'::text" },
        { table_name: 'hook_registrations', is_nullable: 'NO', column_default: "'skip'::text" },
      ]);

      // A hook registered without a policy reads as 'skip'.
      await db.query(
        `INSERT INTO public.hook_registrations (id, name, source_path) VALUES ($1, $2, $3)`,
        ['hookreg-1111111111111-aaaaaaaaa', HOOK, '/nonexistent/test-hook/hook.ts']
      );
      const { rows: before } = await db.query<{ unattended_policy: string }>(
        'SELECT unattended_policy FROM public.hook_registrations WHERE name = $1',
        [HOOK]
      );
      expect(before).toEqual([{ unattended_policy: 'skip' }]);

      await db.query(
        `UPDATE public.hook_registrations SET unattended_policy = 'auto-approve-allowed' WHERE name = $1`,
        [HOOK]
      );
      await expect(
        db.query(
          `UPDATE public.hook_registrations SET unattended_policy = 'approve-all' WHERE name = $1`,
          [HOOK]
        )
      ).rejects.toThrow(/hook_registrations_unattended_policy_check/);
    } finally {
      await close();
    }
  });
});
