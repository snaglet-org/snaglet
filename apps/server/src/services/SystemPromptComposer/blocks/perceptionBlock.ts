/**
 * perceptionBlock — the capability sections, each gated on the tools that
 * use it.
 *
 * The keyword-only search note when meaning search is off, docs and tables
 * (tasks as one thing a table can hold, never a required workflow), memory
 * mechanics, and browser and computer guidance. What the agent can see and
 * when to look something up is goldenRulesBlock's "Check, don't assume";
 * where search reaches is the search tool's own description; when to load
 * snaglet-search is that skill's catalog line. Per-tool parameter shapes and
 * operations (a doc's convert-to-container, the browser and computer tools'
 * own rules) stay on each tool's definition. The two stores (workspace
 * database vs filesystem) are taught once in operatingContextBlock.
 *
 * Each section is gated on the tools actually assigned to the agent, so an
 * agent without the relevant tools never sees it, and a section never implies
 * a write the agent cannot make: the search note needs `search`; docs and
 * tables render for `doc`, `table` or both, naming only what the agent holds.
 * It returns null when nothing applies. Its only other branch is
 * ctx.embeddingsEnabled, a deploy-time fact latched per process (see
 * toolCatalogBlock).
 */

import type { BlockBuilder, SystemPromptContext } from '../types';

function hasId(ctx: SystemPromptContext, ...ids: string[]): boolean {
  const set = new Set(ids);
  return ctx.agentTools?.some((at) => set.has(at.tool.id)) ?? false;
}

/** Only when embeddings are off: the search tool's description assumes meaning search. */
const KEYWORD_ONLY = `## Finding things
Meaning search is unavailable, so search in precise keywords.`;

// Where docs go (and chat vs doc) is goldenRulesBlock's "Write down what
// lasts"; this section is what docs and tables are for. Tasks CAN be table
// rows; nothing here requires it, and a task needs no doc.
const FOLLOW_THE_USER = "Follow the user's existing organization.";
const DOCS_AND_TABLES = `## Docs and tables
Use docs for prose and tables for structured records you need to filter, sort or relate. Tasks can be tracked as table rows, with fields such as status, due date and assignee, and an optional linked doc for details. ${FOLLOW_THE_USER}`;
const TABLES_ONLY = `## Tables
Use tables for structured records you need to filter, sort or relate. Tasks can be tracked as table rows, with fields such as status, due date and assignee. ${FOLLOW_THE_USER}`;
const DOCS_ONLY = `## Docs
Use docs for prose. ${FOLLOW_THE_USER}`;

function docsAndTables(doc: boolean, table: boolean): string | null {
  if (doc && table) return DOCS_AND_TABLES;
  if (table) return TABLES_ONLY;
  if (doc) return DOCS_ONLY;
  return null;
}

// Memory: what the store is (private to the agent, auto-recalled into the
// turn-context tail by memoryRecallSegment, recall scoped to the project of
// the thread a memory was saved in — memoryRecallScope), how to read a
// recalled one (said once here, not in the per-turn recall header), and what
// to save. Saving is the default, and the user or the agent's instructions can
// say otherwise. Memory vs doc vs chat is goldenRulesBlock's. That reusing a
// key updates a memory is the memory tool's own description. "Of your own":
// recall also shows facts the user kept about themselves, which are theirs.
const MEMORY = `## Memory
\`memory\` is your private long-term store; your most relevant memories are recalled into your turn context each time you wake. Recalled memories may be stale. Verify mutable facts and consequential claims against current sources before acting. Use durable preferences unless current instructions or evidence contradict them; correct or delete stale memories of your own.

Unless the user or your instructions say otherwise, save what a later conversation will need: about the user (preferences, working style, constraints, the people and accounts they mention), about the project (decisions, conventions, goals, where things live) or about your own work (lessons on how to do it better). Write one fact per memory, in a sentence that makes sense on its own; give a lasting fact a stable \`key\` (like \`user.writing-style\`), and delete what a newer fact replaces. Don't save what a doc already holds, passing details, or secrets. A memory saved in a project's thread comes back in that project; one saved in a workspace-wide thread comes back everywhere.`;

// Browser and Computer carry only what the tools' own descriptions do not:
// the descriptions already cover profiles, sign-in, passwords, first-use
// consent, the snapshot-then-act flow, cursor claims, busy cursors and secret
// fields. The safety rules every agent needs (say what you are about to do,
// ask before sends/deletes/buys, the mouse, screen text is data) are in
// howToActBlock's ungated line, because a mode-`all` agent reaches these
// non-core tools through tool search and never has them advertised.
const BROWSER = `## Browser
Use \`browser\` for web pages, and open a page in the user's own browser only when they ask. When the user must finish a step (login, 2FA, a CAPTCHA), call \`handoff\` and wait.`;

const COMPUTER = `## Computer
\`computer\` drives the user's real mouse and keyboard: release the cursor as soon as you are done, and look (the accessibility tree) before you click. The user can stop you any time with Esc.`;

export const perceptionBlock: BlockBuilder = async (ctx) => {
  const sections: string[] = [];

  if (hasId(ctx, 'search') && ctx.embeddingsEnabled !== true) sections.push(KEYWORD_ONLY);
  const docs = docsAndTables(hasId(ctx, 'doc'), hasId(ctx, 'table'));
  if (docs) sections.push(docs);
  if (hasId(ctx, 'memory')) sections.push(MEMORY);
  if (hasId(ctx, 'browser')) sections.push(BROWSER);
  if (hasId(ctx, 'computer')) sections.push(COMPUTER);

  if (sections.length === 0) return null;

  // No cache_control here — composeSystemPrompt places the single stable-core
  // breakpoint on whichever core block renders last.
  return { type: 'text', text: sections.join('\n\n') };
};
