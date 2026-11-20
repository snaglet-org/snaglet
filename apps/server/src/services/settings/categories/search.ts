/**
 * `search` category settings.
 *
 * Registered into the settings registry on module load (see
 * apps/server/src/services/settings/index.ts which side-effect-imports
 * this file). New consumers should use `settingsService.read(searchSettings.preferences)`
 * rather than the `readSearchPreferences()` helper.
 */

import { z } from 'zod';
import { defineCategory } from '../defineSetting';

const SearchPreferencesSchema = z.object({
  // Internal defaults for agent workspace_search. Human-facing keyword/vector
  // choices are per-query controls on the tree and Cmd+K; they use request
  // `mode` and never rewrite this workspace-wide record.
  useVector: z.boolean(),
  useFts: z.boolean(),
  // The six ranking fields below intentionally have no UI. They remain
  // settings-row-only while graph ranking experiments are evaluated.
  useGraphWalk: z.boolean(),
  // When on, link-proximate neighbors are fused alongside vector+FTS so a node
  // that is both semantically relevant and link-proximate gets reinforced.
  // optional() keeps existing persisted settings rows valid without a migration.
  useGraphChannel: z.boolean().optional(),
  // Attenuates each neighbor's graph score by inverse-log of its link degree,
  // suppressing high-degree hub nodes. Only meaningful when useGraphChannel is on.
  useGraphHubDamping: z.boolean().optional(),
  // Excludes hub node kinds (e.g. thread_summary) from graph-channel membership
  // entirely. Only meaningful when useGraphChannel is on.
  useGraphHubExclude: z.boolean().optional(),
  // Booster: trigram fuzzy matching over doc/task titles and
  // memory keys, fused as an RRF channel. Default OFF until it wins its
  // eval-set A/B (each booster is measured alone before turning on).
  useFuzzyTitles: z.boolean().optional(),
  threadBoost: z.boolean(),
});

export type SearchPreferences = z.infer<typeof SearchPreferencesSchema>;

export const searchSettings = defineCategory('search', {
  preferences: {
    key: 'preferences',
    schema: SearchPreferencesSchema,
    // All-true default matches the server's pre-migration default. The UI's
    // duplicate `searchPreferences.ts` had its own copy with mixed values —
    // that file is deleted in subtask 10. From now on, the registry is the
    // single source of truth and the UI imports defaults from it.
    default: {
      useVector: true,
      useFts: true,
      useGraphWalk: true,
      useGraphChannel: false,
      useGraphHubDamping: false,
      useGraphHubExclude: false,
      useFuzzyTitles: false,
      threadBoost: true,
    },
    description:
      'workspace_search channel + ranking toggles. useVector enables semantic; useFts enables lexical; useGraphWalk follows link edges (legacy post-fusion backfill); useGraphChannel fuses link-proximate neighbors as a real RRF channel (default off, experimental); useFuzzyTitles fuses trigram name matches as an RRF channel (default off, experimental); threadBoost ranks thread-resident results higher.',
  },
  // Search by meaning over custom tables' rows is on by default up to the row
  // cap (services/tableSemantic/defaultOn.ts). A table with it on has a
  // `table_semantic_search` row; these two settings hold the rest.
  tableSemanticOff: {
    key: 'table_semantic_off',
    schema: z.record(z.string(), z.string()),
    default: {} as Record<string, string>,
    description:
      'Internal: custom tables a person turned search by meaning off for (table id to when). The default never turns these on again; turning one on removes it.',
    nullRemovesEntry: true,
  },
  tableSemanticDefaultOn: {
    key: 'table_semantic_default_on',
    schema: z.object({ done: z.string() }).nullable(),
    default: null,
    description:
      'Internal: when Snaglet turned search by meaning on for the existing custom tables up to 10,000 rows (services/tableSemantic/defaultOn.ts). Set once; while set that backfill never runs again.',
  },
});
