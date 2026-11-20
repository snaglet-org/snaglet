import type { OnboardingDocSource } from './types';

/** The docs of the sample project, "My First Project (Sample)", which the user can edit or delete. */
export const SAMPLE_PROJECT_DOCS: readonly OnboardingDocSource[] = [
  {
    slug: 'project-overview',
    title: 'Project Overview',
    folder: 'sample-project',
    body: `# Project Overview

*This is a sample project. Edit it to make it your own, or delete the whole project when you no longer need it.*

A project keeps one body of work together. This one shows the pieces.

## What's in this project

- This overview.
- [Meeting Notes: Kickoff](onboarding:kickoff-meeting-notes): one way to write up a meeting.
- [Decision Log](onboarding:decision-log): a running list of what was decided and why.
- [sample_project_tasks](onboarding-table:sample-tasks): this project's own task list. Each task has a status, a priority and a due date that shows on the calendar.

## What a project can hold

- **Docs**: notes, plans, specs and meeting notes
- **Folders**: to group related docs
- **Tables**: tasks, contacts, resources
- **Threads**: conversations with agents about this work
- **Files**: link a folder on your computer in the project's **Properties**, and its files show here

## How to use it

1. **Explore**: open each doc and the task table.
2. **Make it yours**: rename the project and replace this text with your own goals.
3. **Clean up**: archive or delete the project when you are done with it.

## Goals

*Write two or three goals for this project here.*

**Ask Patty:** "Turn this sample into a project for my own work."
`,
  },
  {
    slug: 'kickoff-meeting-notes',
    title: 'Meeting Notes: Kickoff',
    folder: 'sample-project',
    body: `# Meeting Notes: Kickoff

*A sample that shows one way to write meeting notes. Replace it with your own, or delete it.*

- **When:** Week 1
- **Who:** You and [Patty](patty)
- **Topic:** Getting this project started

## Discussion

- What this project is for, and what "done" looks like.
- How to keep track of the work: tasks in [sample_project_tasks](onboarding-table:sample-tasks), decisions in the [Decision Log](onboarding:decision-log).
- Type \`@\` to link a doc, thread, table row or agent right in your notes.

## Decisions

- Use Snaglet to organize this project.
- Start small and adjust as we go.

## Action items

- [ ] Read the [Project Overview](onboarding:project-overview)
- [ ] Add your own tasks to [sample_project_tasks](onboarding-table:sample-tasks)
- [ ] Log your first real decision in the [Decision Log](onboarding:decision-log)

## Next meeting

*Not scheduled yet. Add it to the calendar when you know.*

**Ask Patty:** "Turn the action items in these notes into tasks."
`,
  },
  {
    slug: 'decision-log',
    title: 'Decision Log',
    folder: 'sample-project',
    body: `# Decision Log

*A sample decision log. Keep it for your own decisions, or delete it.*

A decision log records what was decided and why, so nobody argues the same point twice and anyone who joins later can catch up.

## Decisions

### Use Snaglet to organize this project

- **When:** Week 1
- **Context:** The work was spread across notes and lists in different places.
- **Decision:** Keep this project's docs, tasks and conversations in Snaglet.
- **Why:** Everything in one place, with agents that can find and update it.
- **Status:** Active

### Your next decision

- **When:**
- **Context:**
- **Decision:**
- **Why:**
- **Status:**

**Tip:** Link a decision to the doc or task it came from: type \`@\` and pick it.

**Ask Patty:** "Add a decision to this log for me."
`,
  },
];
