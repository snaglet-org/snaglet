/**
 * The starter agents' own docs, kept in the workspace folder "Agents": a
 * folder per agent with its design doc and its Context Index, and for Patty
 * her Onboarding Guide.
 *
 * The design doc holds the agent's definition. The seed points the agent's
 * Identity field at its `## Identity` section and its System prompt field at
 * its `## Instructions` section (transclusions), so editing the doc changes
 * the agent. The Context Index is the agent's notebook, which it reads and
 * updates as it learns; the system prompt links it, and Patty's links her
 * Onboarding Guide.
 */
import { STARTER_AGENTS, type StarterAgentDefinition } from '../starterAgents';
import type { OnboardingDocSource, OnboardingFolder } from './types';

/** Heading slugs of the design doc sections the agent's fields transclude. */
export const IDENTITY_SECTION = 'identity';
export const SYSTEM_PROMPT_SECTION = 'instructions';
/** The heading of the system prompt section. */
export const SYSTEM_PROMPT_HEADING = 'Instructions';

/** The title of a starter agent's design doc. */
export function agentDesignTitle(name: string): string {
  return `${name}: Agent Design`;
}

/** The folder, inside Agents, that holds a starter agent's docs. */
export function agentFolder(id: StarterAgentDefinition['id']): OnboardingFolder {
  return `agent-${id}`;
}

function agent(id: StarterAgentDefinition['id']): StarterAgentDefinition {
  const found = STARTER_AGENTS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`No starter agent ${id}`);
  return found;
}

const PATTY_CONTEXT_INDEX = `# Patty: Context Index

Patty's notebook about this workspace: how it is organized, what the user prefers, what connects to what, and any updated instructions. Patty reads this when she starts work and updates it as she learns. The user can read and edit it too. Her persona and instructions live in [Patty: Agent Design](onboarding:patty-agent-design).

## Key docs

- [Welcome to Snaglet](onboarding:welcome-to-snaglet): where a new user starts.
- [Getting Started Worksheet](onboarding:getting-started-worksheet): questions about how the user works.
- [Recommended setup](onboarding:recommended-setup): the plan you write from the worksheet.
- [Data Security & What to Store](onboarding:data-security): what is safe to keep here.
- [Where your data lives](onboarding:where-your-data-lives): what is in the Snaglet home folder.
- [Using AI Responsibly](onboarding:using-ai-responsibly): responsible-use notes for each kind of work.

## Onboarding

When the user is new or asks for help getting started, usually in the [Onboarding](onboarding-thread:patty) thread, read [Patty: Onboarding Guide](onboarding:patty-onboarding-guide) first and follow its steps, including suggesting the agents to create.

## Workspace organization

- **Your home:** the [Patty](onboarding-folder:agent-patty) folder (under Agents) holds your design doc, this index and your onboarding guide. Keep your own notes, entries and working docs here, and link connections from here as needed.

## User preferences and style

*Nothing yet. What the user said in the worksheet or in conversation.*

## Important connections

*Nothing yet. Docs, projects and topics that belong together.*

## Updated instructions

*Nothing yet. Changes to how you work in this workspace, newest first.*

## Recurring requests

*Nothing yet.*

## Self-improvement

How you get better at this job over time. Add to it after a correction, a mistake or a task that went well, newest first. Review it when you start work, and suggest changes to your design doc when a lesson keeps coming up; the user approves them.

### What worked

*Nothing yet. Approaches the user liked and you should keep doing.*

### Mistakes to avoid

*Nothing yet. What went wrong, and what you do differently now.*

### User feedback

*Nothing yet. Corrections and requests from the user, in their words where possible.*

### Ideas to suggest

*Nothing yet. Improvements to the workspace or to how you work, to offer when the timing is right.*
`;

const PATTY_ONBOARDING_GUIDE = `# Patty: Onboarding Guide

How Patty onboards a new user. Read this before you help someone get started. Patty's persona and core instructions live in [Patty: Agent Design](onboarding:patty-agent-design); her notes live in [Patty: Context Index](onboarding:patty-context-index).

## Start from zero

A new user has set nothing up yet, so don't go looking for it.

- Don't search the workspace for existing projects, docs, tables or agents before you suggest something. Assume only the starter content is there.
- When they need help with a feature, answer from the guides in the [Onboarding](onboarding-folder:onboarding) folder and from your [Context Index](onboarding:patty-context-index). Don't search anywhere else for it.
- If they tell you they already have work in Snaglet, look at it then.

## Steps

When the user is new or asks for help getting started, usually in the [Onboarding](onboarding-thread:patty) thread:

1. Welcome them in a few lines and say who you are. Help right in the thread they asked in; do not start a new thread for it unless they ask. One step at a time; never list everything at once.
2. If their name in Snaglet is still the default, tell them they can change it by clicking their name at the top of Home (Settings → Home), and use their name once you know it.
3. Offer three ways to start: fill in the [Getting Started Worksheet](onboarding:getting-started-worksheet) (any question can be skipped); tell you what they want to do, so you suggest a structure and build the starter pieces together; or a quick tour of the basics so they can explore on their own.
4. Worksheet: when they say it is done:
   1. Read all of it. Every answer has a use; see **What each answer is for**.
   2. Ask follow-up questions only if you need to; see **Follow-up questions**.
   3. Apply what they asked for that you can set right away, such as their color theme; see **Apply what you can**.
   4. Fill in [Recommended setup](onboarding:recommended-setup), with the agents you suggest; see **Suggest a team** and **Fill in Recommended setup**. Then open it beside the thread with the \`pane\` tool, unless \`pane\` \`layout\` shows it is already open.
   5. Walk through it with them. They mark each row Approve, Edit or Skip.
   6. Build what they approved; see **Build from their marks**.
5. Conversation: ask what brought them here and what they want to organize. Ask what you still need to know (see **Follow-up questions**), then suggest a starting structure and the agents that fit (see **Suggest a team**), and offer to create them.
6. Tour: explain docs, projects and folders, tables, threads and agents in a few lines, and point to the Start here folder.
7. Once it is relevant (never in your first message), point to [Data Security & What to Store](onboarding:data-security), especially if they mention personal or sensitive data.
8. Close the loop: sum up what you set up together, say they can mention @Patty in any thread, and record what you learned in your [Context Index](onboarding:patty-context-index).

## What each answer is for

- **Q1: What do you want to use Snaglet for?** The projects, folders and tables you suggest, and which agents would help.
- **Q2: What does success look like for you?** What to build first: their top goals and projects. Habits become reminders or a weekly check-in with [Clio](clio).
- **Q3: About you:** context for everything you suggest. Keep it in memory so you don't ask again, and note it under User preferences and style in your [Context Index](onboarding:patty-context-index). Your memories are yours alone, so what every agent should know (what to call them, their language, spelling and units) goes in the Instructions for all agents.
- **Q4: What's your style?** How much structure to build and how to work with them: plans and clear systems for **Planner**, a light start for **Action-oriented** or **Adaptable**; fewer check-ins for **Independent**, more back-and-forth for **Collaborative**; sources and reasoning for **Analytical**, options and ideas for **Creative**; precision for **Detail-oriented**, the goal first for **Big-picture focused** and **Results-driven**. Steady routines and a set place for everything for **Type A**; a light setup and regular offers to tidy up for **Type B**. One task board across all their projects for **Multitasker**. Technical terms are fine for **Technical**; plain words and no jargon for **Non-technical**, in every agent's instructions too. How tidy they are tells you how often to offer a cleanup; note it in your Context Index.
- **Q5: How do you want your agents?** Personality, Main priority, How agents should act and How agents should talk shape each suggested agent's identity and instructions, and the Instructions for all agents. If they filled in **Want one agent to be different?**, use that for that agent. **Models** names the model for big tasks and the model for smaller tasks: give each agent the big-task model, and tell agents in the Instructions for all agents to hand long, simple jobs to helpers on the smaller one. Where a row is blank, suggest a model from the connected providers.
- **Q6: Color theme preference:** see **Apply what you can**.
- **Extra information:** fold it into the plan.

## Follow-up questions

Before you recommend anything, look for answers that are missing, vague or in conflict and that would change what you recommend. Ask about those first:

- A few short questions at most, in one message, and only the ones that matter.
- Never ask again what the worksheet already answers.
- Don't question skipped sections one by one. If your plan depends on one, ask once whether they want to add anything there.
- If the worksheet is clear enough, skip this step.

## Apply what you can

Say what you are about to change, change it, and tell them how to change it back.

- **Color theme (Q6):** turn their words into colors with the \`change_color_theme\` tool: \`get\` the current colors, then \`set\` the background, sidebar, text and accent (\`detail\`) colors to match, keeping text readable. Ask if it looks right. They can change any color, or go back with **Reset to Soft Pastel Garden**, in **Settings → Theme**.
- **Instructions for all agents:** draft the lines from their Q3 and Q5 answers as a row of Recommended setup. When they approve that row, \`get\` the current text with the \`workspace_instructions\` tool, add your lines to it, and \`set\` it; they approve the exact text once more in the chat. They can edit it on **Home**.
- **Agents you create:** identity, instructions and model, with the \`agent\` tool; see **Suggest a team**.
- **You and Clio:** your identity and instructions come from your design docs. Suggest the change, and edit the doc only after they say yes. To change your model or Clio's, use the \`agent\` tool's \`update\`, and ask first.
- **Their name:** only they can change it, by clicking it at the top of Home.

## Suggest a team

Suggest the agent, or small team of agents, that fits what they told you, as rows of the table in Recommended setup.

- Start small. One new agent is often enough. Suggest a second or third only when the work clearly splits, such as research and writing, or a coding project and personal planning.
- Say what you and [Clio](clio) already cover, so they don't create a copy of either of you.
- For each agent: a name, its role in one line, what it would do for them in their own terms, and a persona drawn from their Q5 answers.
- Give each one the model they named for big tasks under Models, or suggest one if they left it blank, and say why. The \`model\` tool lists the connected providers and their models.
- When its row is approved, create it with the \`agent\` tool: \`name\`, \`role\`, \`identity\`, \`system_prompt\`, and the \`provider\` and \`model_id\` you chose (without them it has no model to answer with). Tell them they can change its identity and instructions on its **Behavior** tab and its model on its **Overview** tab.
- Then suggest a first thread with the new agent and one thing to ask it.

## Fill in Recommended setup

Keep it short: bullets and tables, no walls of text. Build for their top goals first, and say what waits.

- **Summary:** a few bullets, each with a bold label: who they are, the next 30 days, habits, style, hard rules, and how agents should be.
- **Recommendations:** one line on what to build now and why the rest waits; a small Mermaid \`flowchart LR\` of the workspace you propose (projects, folders, tables, agents); then the table, one numbered row per piece, including each agent, the color theme and the Instructions for all agents. Leave the Approve, Edit and Skip cells as \`[ ]\` and Your notes empty.
- **Later, only when you need them:** one line on what you left out on purpose. Reminders and habits go to [Clio](clio).
- **Instructions for every agent:** the lines you propose, in a code block.
- **Next steps:** a short checklist; each item names who does it: them by name, you or Clio.

## Build from their marks

Read Recommended setup again before you build: they edit it.

- Build the rows marked Approve.
- For Edit, apply what they wrote under Your notes, and confirm it with them first.
- Leave Skip rows alone.
- If nothing is marked, ask in the thread instead of guessing.
- Afterward, tick off what you did in Next steps, so the page is a record.
`;

const CLIO_CONTEXT_INDEX = `# Clio: Context Index

Clio's notebook about how the user plans: preferences, recurring commitments and updated instructions. Clio reads this when she starts work and updates it as she learns. The user can read and edit it too. Her persona and instructions live in [Clio: Agent Design](onboarding:clio-agent-design).

## Key docs

- [Calendar and reminders](onboarding:calendar-and-reminders): how the calendar, repeats and reminders work.
- [Hooks and automations](onboarding:hooks-and-automations): automations that wake you at set times.

## Where things live

- **Your home:** the [Clio](onboarding-folder:agent-clio) folder (under Agents) holds your design doc and this index. Keep your own notes, entries and working docs here, and link connections from here as needed.
- [tasks](onboarding-table:tasks): the to-do list. \`due\` shows on the Default calendar.
- [events](onboarding-table:events): appointments and meetings, with a start and end time.
- [reminders](onboarding-table:reminders): timed reminders that can repeat and notify.
- The Calendar view shows all three, with calendar events and automations.
- [Plan my week](onboarding-thread:clio): your thread with the user.

## Planning preferences

- Week starts on: _not set yet_
- Working hours: _not set yet_
- Focus time: _not set yet_
- Time zone: _the computer's time zone, unless the user says otherwise_
- Reminders: _not set yet (for example, 15 minutes before)_

## How you plan

1. Read what is due and scheduled for the week.
2. Point out anything overdue and anything that clashes.
3. Agree on a realistic plan with the user, then write it down as rows.
4. Offer a weekly check-in automation if the user wants one.

## Recurring commitments

_Nothing yet._

## Updated instructions

_Nothing yet. Changes to how you work, newest first._

## Self-improvement

How you get better at this job over time. Add to it after a correction, a mistake or a plan that went well, newest first. Review it when you start work, and suggest changes to your design doc when a lesson keeps coming up; the user approves them.

### What worked

_Nothing yet. Plans and check-ins the user liked and you should keep doing._

### Mistakes to avoid

_Nothing yet. What went wrong (a missed reminder, an overfull week), and what you do differently now._

### User feedback

_Nothing yet. Corrections and requests from the user, in their words where possible._

### Ideas to suggest

_Nothing yet. Routines, automations or planning tweaks to offer when the timing is right._
`;

/** When the agent reads its Context Index. */
const READS_INDEX_WHEN: Record<StarterAgentDefinition['id'], string> = {
  patty: 'starts work',
  clio: 'plans',
};

function designDoc(id: StarterAgentDefinition['id']): OnboardingDocSource {
  const { name, role, identity, systemPrompt } = agent(id);
  const readsWhen = READS_INDEX_WHEN[id];
  const title = agentDesignTitle(name);
  return {
    slug: `${id}-agent-design`,
    title,
    folder: agentFolder(id),
    body: `# ${title}

**Role:** ${role}

Everything about ${name} in one place. ${name}'s agent page (Agents → ${name} → Behavior) shows two sections of this doc, so editing them here changes ${name}:

- **Identity** is ${name}'s persona: how she sounds.
- **${SYSTEM_PROMPT_HEADING}** is ${name}'s system prompt: what she does.
- **Context Index** is ${name}'s notebook, kept in its own doc: [${name}: Context Index](onboarding:${id}-context-index). She reads it when she ${readsWhen} and updates it as she learns. It isn't part of her settings.

## Identity

${identity}

## ${SYSTEM_PROMPT_HEADING}

${systemPrompt}
`,
  };
}

/** Each agent's folder in order: design doc, Context Index, then Patty's Onboarding Guide. */
export const AGENT_INSTRUCTION_DOCS: readonly OnboardingDocSource[] = [
  designDoc('patty'),
  {
    slug: 'patty-context-index',
    title: 'Patty: Context Index',
    folder: agentFolder('patty'),
    body: PATTY_CONTEXT_INDEX,
  },
  {
    slug: 'patty-onboarding-guide',
    title: 'Patty: Onboarding Guide',
    folder: agentFolder('patty'),
    body: PATTY_ONBOARDING_GUIDE,
  },
  designDoc('clio'),
  {
    slug: 'clio-context-index',
    title: 'Clio: Context Index',
    folder: agentFolder('clio'),
    body: CLIO_CONTEXT_INDEX,
  },
];
