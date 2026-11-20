/**
 * The shape of the starter docs a fresh install gets. Each body is Markdown
 * that starts with `# <title>`, except a doc another doc transcludes whole,
 * which reads in place without one.
 *
 * Links between seeded items are written with placeholders and resolved to
 * real ids when the seed runs:
 *
 * - `[Text](onboarding:<doc slug>)` links another seeded doc, and
 *   `[Text](onboarding:<doc slug>#h=<heading slug>)` one of its headings.
 * - `![](onboarding:<doc slug>)` transcludes another seeded doc.
 * - `[Text](onboarding-folder:<folder>)` links a seeded folder or project.
 * - `[Text](onboarding-table:<ideas|tasks|events|reminders|sample-tasks>)` links a starter table.
 * - `[Text](onboarding-thread:<patty|clio>)` links a starter agent's thread.
 * - `[Patty](patty)` and `[Clio](clio)` link the starter agents as they are.
 */

/**
 * Where a seeded doc lives. `start`, `features`, `reference` and `etc` are
 * the folders inside the Onboarding folder, in sidebar order, and
 * `responsible-ai` is the Using AI Responsibly folder inside Reference;
 * `sample-project` is the sample project; `agents` is the workspace folder
 * that holds a folder per starter agent, `agent-<id>`, with its own docs.
 */
type StarterAgentId = 'patty' | 'clio';

export type OnboardingFolder =
  | 'start'
  | 'features'
  | 'reference'
  | 'responsible-ai'
  | 'etc'
  | 'sample-project'
  | 'agents'
  | `agent-${StarterAgentId}`;

export interface OnboardingDocSource {
  /** Stable key, used by placeholder links and tests. Lowercase words joined by `-`. */
  slug: string;
  title: string;
  folder: OnboardingFolder;
  /** Markdown; the first line is `# ${title}` unless another doc transcludes this one whole. */
  body: string;
}
