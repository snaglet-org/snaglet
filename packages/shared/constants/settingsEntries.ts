/**
 * The rows of the Settings sidebar, by row id, as the person reads them. The
 * starter guides, the agent prompts and the user guide send people to them as
 * "Settings → <label>", and a content test holds those names to this list.
 */
export const SETTINGS_ENTRY_LABELS = {
  'get-started': 'Get started',
  hub: 'Home',
  profile: 'Profile',
  cli: 'Command line',
  theme: 'Theme',
  'agent-instructions': 'Agents',
  browser: 'Browser',
  updates: 'Updates',
  embeddings: 'Embeddings',
  backups: 'Backups',
  storage: 'Local storage',
} as const;
