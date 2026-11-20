/**
 * Resolve the onboarding seed's link placeholders (content/types.ts) to the
 * ids the seed created. A placeholder with no id renders as its plain text,
 * so a doc or prompt never shows a link that leads nowhere.
 */

export interface SeedIds {
  /** Doc id by slug. */
  docs: Readonly<Record<string, string>>;
  /** Container id by folder key (`onboarding` is the Onboarding folder itself). */
  folders: Readonly<Record<string, string>>;
  /** table_catalog id by starter table key. */
  tables: Readonly<Record<string, string>>;
  /** Thread id by starter agent id. */
  threads: Readonly<Record<string, string>>;
}

/**
 * `[text](onboarding:slug)` and its `-folder`, `-table`, `-thread` forms; a
 * doc link may end in `#h=<heading slug>`, which is kept.
 */
const SEED_LINK_RE =
  /\[((?:\\.|[^\]\\])*)\]\((onboarding(?:-folder|-table|-thread)?):([a-z0-9-]+)(#h=[a-z0-9-]+)?\)/g;

export const NO_SEED_IDS: SeedIds = { docs: {}, folders: {}, tables: {}, threads: {} };

function target(ids: SeedIds, scheme: string, key: string): string | null {
  switch (scheme) {
    case 'onboarding':
      return ids.docs[key] ?? null;
    case 'onboarding-folder':
      return ids.folders[key] ?? null;
    case 'onboarding-table': {
      const id = ids.tables[key];
      return id ? `table:${id}` : null;
    }
    case 'onboarding-thread':
      return ids.threads[key] ?? null;
    default:
      return null;
  }
}

export function resolveSeedLinks(markdown: string, ids: SeedIds): string {
  return markdown.replace(
    SEED_LINK_RE,
    (_match, text: string, scheme: string, key: string, heading: string | undefined) => {
      const resolved = target(ids, scheme, key);
      return resolved ? `[${text}](${resolved}${heading ?? ''})` : text;
    }
  );
}
