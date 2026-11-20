/**
 * `onboarding` category settings: the starter content a fresh install gets,
 * and each person's place in the Get started pane.
 *
 * `seed` is written `{status: 'pending'}` by the database bootstrap, only when
 * it creates a brand-new schema (packages/db/migrations.ts). The server's
 * onboarding seed (services/onboarding/seedOnboarding.ts) runs only from
 * `pending`, and records what it created. Every other status is final, so
 * deleting the starter content never brings it back, and a database that
 * existed before this setting never gets it.
 *
 * `progress` maps a user id to what that person did in the Get started pane.
 * The desktop writes it one entry at a time through the settings entry routes
 * (`PUT /api/settings/onboarding/progress/entries/<userId>`).
 */

import { z } from 'zod';
import { defineCategory } from '../defineSetting';

const IdMapSchema = z.record(z.string(), z.string());

const SeedRecordSchema = z
  .object({
    status: z.enum(['pending', 'running', 'done', 'skipped', 'failed']),
    at: z.string().optional(),
    error: z.string().optional(),
    /** Container ids by folder key; `onboarding` is the Onboarding folder. */
    folders: IdMapSchema.optional(),
    /** Doc ids by slug. */
    docs: IdMapSchema.optional(),
    /** table_catalog ids by starter table key. */
    tables: IdMapSchema.optional(),
    /** Thread ids by starter agent id. */
    threads: IdMapSchema.optional(),
  })
  .nullable();

export type OnboardingSeedRecord = NonNullable<z.infer<typeof SeedRecordSchema>>;

const ProgressSchema = z.object({
  /** When the person chose Skip for now on the provider step. */
  providerSkippedAt: z.string().optional(),
  /** When a provider test first succeeded in the Get started pane. */
  providerReadyAt: z.string().optional(),
  /** The provider that test was for. */
  providerId: z.string().optional(),
  /** When the person first opened Patty's thread from the pane. */
  pattyOpenedAt: z.string().optional(),
});

const ProgressByUserSchema = z.record(z.string(), ProgressSchema);

export const onboardingSettings = defineCategory('onboarding', {
  seed: {
    key: 'seed',
    schema: SeedRecordSchema,
    default: null,
    description:
      'Internal: the starter content seeded on a fresh install (status pending → running → done, ' +
      'or skipped/failed) and the ids it created. Only a fresh database starts at pending.',
  },
  progress: {
    key: 'progress',
    schema: ProgressByUserSchema,
    default: {} as z.infer<typeof ProgressByUserSchema>,
    description:
      "Each person's progress in the Get started pane, keyed by user id: " +
      '{providerSkippedAt, providerReadyAt, providerId, pattyOpenedAt}.',
  },
});
