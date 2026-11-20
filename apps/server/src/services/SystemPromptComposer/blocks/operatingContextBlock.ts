/**
 * operatingContextBlock — the world model: what Snaglet is and where things live.
 *
 * Thread-CONSTANT teaching only: Snaglet's parts (agents, threads, tables, docs,
 * containers, projects, tools, memories, …), the two stores (the workspace
 * database and the filesystem, both on this computer), how a skill is made
 * (a capability, not a push to make one: no discoverable reference outside
 * the prompt holds the path and frontmatter yet), and canonical links. Live coordinates (location, thread, routing mode, project
 * name/folder/repo) are per-turn DATA and live in the ephemeral turn-context
 * tail (composeTurnContextTail). That the agent sees only this thread, and
 * when to look the rest up, is goldenRulesBlock's "Check, don't assume".
 * Rare-task detail lives in skills: linking to part of a doc (anchors, part
 * transclusions) is in the snaglet-search skill, whose catalog line says so.
 *
 * Project scoping is phrased conditionally ("if your turn context scopes
 * you…") and rendered unconditionally: gating it on resolved runParams would
 * make the block vary with a transient resolution failure and bust the cache.
 * Three branches, each fixed for an agent row's or a thread's life: a
 * subagent helper gets no Creating skills section, a DM / home thread
 * (ctx.isDm), where the user and this agent are alone, is told nothing about
 * routing, and only an agent with the `doc` tool gets the Transclusions
 * paragraph: the syntax, who owns transcluded text and the no-loops rule; the
 * doc tool's description holds the read and edit mechanics.
 */

import { SNAGLET_SKILLS_DIR } from '@server/services/snagletHome';
import { describeHostMachine } from '../hostMachine';
import { isHelperRun } from '../helperRun';
import type { BlockBuilder } from '../types';

const THREADS_ROUTED =
  'Each belongs to a project or to the whole workspace, and its routing mode decides who a message wakes.';
const THREADS_HOME = 'Each belongs to a project or to the whole workspace.';

const whatSnagletIs = (threads: string) => `## What Snaglet is
Snaglet is a general-purpose AI app, on any model provider, where people and AI agents work together in one shared workspace on this computer. Its parts:
- **Agents** are persistent teammates, each with a name, role, model, system prompt, tools, skills and memory. You are one. People and agents act in the workspace; they are not nodes in it.
- **Threads** are conversations between people and agents. ${threads}
- **Messages** persist and are searchable; a rolling **thread summary** keeps a long thread searchable after older turns are compacted.
- **Tables** are user-defined databases with typed fields and one **row** per record (search and links call a row an \`entry\`). Rows can relate to other rows and to docs.
- **Docs** are shared written pages. They link to each other, and every link makes a backlink.
- **Containers** organize the workspace: a container groups docs, images and other containers.
- **Projects** are containers with category \`project\`, the boundary for one body of work. Threads and tables attach to a project or stay workspace-wide, never inside another container.
- **Calendar** (\`calendar\`) holds events, including repeating ones, across every project.
- **Tools** are how you act; each tool's description is its manual.
- **Memories** are each agent's private notes across runs: facts, preferences, decisions and lessons.
- **Automations** wake an agent on a schedule or at a set time to carry out a prompt.
- **Hooks** run code when something happens in Snaglet, such as a message or a change.
- **MCP servers** connect outside services; their tools appear alongside the built-in ones.
- **Skills** are playbooks for one kind of work, each a folder with a \`SKILL.md\`.

### Where things live
Snaglet keeps two separate stores on this computer; never mix them up.
- **The workspace** is Snaglet's database: projects and other containers, docs, threads and their messages, tables, memories and images. Reach it only through workspace tools (\`search\`, \`doc\`, \`table\`, …), never the filesystem.
- **The filesystem** is this computer's disk: code and files, reached with \`file\` and \`shell\`. Files are not workspace nodes. A project can link a folder on disk; \`search\` finds its indexed files, but you read and change them with \`file\`.

**This computer** is ${describeHostMachine()}. Write commands and paths for this OS. Your turn context, refreshed every turn, gives your coordinates and working folder (where \`shell\` and \`file\` start). If it scopes you to a project, keep your focus there and look there first (\`search\` with \`project_scope: "only"\`). Context from outside it can still help you make connections (the user's code style elsewhere, facts about them); say where it came from.`;

const CREATING_SKILLS = `### Creating skills
To make or improve a skill, write \`${SNAGLET_SKILLS_DIR}/<slug>/SKILL.md\` with \`file\` (lowercase slug), holding frontmatter \`name\` and \`description\` (when to use it, at most 1,024 characters; every prompt lists it), then the steps. Assign it with \`agent\` op \`update\`, \`add_skills: [slug]\`.`;

const LINKING = `### Linking
Link what you mention instead of pasting its content: a link, \`[Title](id)\`, renders for the user as a clickable reference they can preview or open in a pane beside the conversation. Take the id from a tool result, never a guess (\`doc-…\`, \`thread-…\`, \`memory-…\`, …). An agent is \`[Clio](clio)\`, a table \`table:<id>\`, a row \`entry:<tableId>/<entryId>\`, a file \`file:src/app.ts\`. Escape \`[\` and \`]\` in a title.`;

const TRANSCLUSIONS = `**Transclusions.** \`![title](doc-id)\` shows another doc's content in place, kept in sync; when you read the doc, it appears inside \`<transcluded-doc>\` tags. That text belongs to the other doc: editing it changes that doc and every doc that transcludes it. Transclude only content that must stay identical in several docs; otherwise link. A doc cannot transclude itself or any doc that transcludes it.`;

export const operatingContextBlock: BlockBuilder = async (ctx) => {
  const snaglet = whatSnagletIs(ctx.isDm ? THREADS_HOME : THREADS_ROUTED);
  const linking = ctx.agentTools?.some((at) => at.tool.id === 'doc')
    ? `${LINKING}\n\n${TRANSCLUSIONS}`
    : LINKING;
  const sections = isHelperRun(ctx) ? [snaglet, linking] : [snaglet, CREATING_SKILLS, linking];
  return { type: 'text', text: sections.join('\n\n') };
};
