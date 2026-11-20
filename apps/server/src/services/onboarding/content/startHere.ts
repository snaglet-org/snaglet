import type { OnboardingDocSource } from './types';

/** The "Start here" folder inside the Onboarding folder, in sidebar order. */
export const START_HERE_DOCS: readonly OnboardingDocSource[] = [
  {
    slug: 'welcome-to-snaglet',
    title: 'Welcome to Snaglet',
    folder: 'start',
    body: `# Welcome to Snaglet

Snaglet is a desktop workspace where you and AI agents work together. You share docs, threads and tables, plan on a calendar, and search everything by meaning. It all lives in a database on your computer.

## Your first steps (all optional)

- [ ] **Set your name.** Step 1 of **Get started**, or click your name at the top of **Home**.
- [ ] **Connect a provider.** Open **Settings** in the activity bar on the far left, then **Get started**. Choose how your agents run: a subscription you already have, an API key, or models on this Mac.
- [ ] **Choose a model for [Patty](patty) and [Clio](clio).** In **Get started**, step 3 suggests a model; click **Use for Patty and Clio**, or pick another. To give one of them its own model, open its page from the **Agents** view, go to the **Overview** tab and choose under **Model**.
- [ ] **Say hello to [Patty](patty).** Open the [Onboarding](onboarding-thread:patty) thread and send her a message, or pick one of the suggestions. Patty finds things, keeps your workspace organized and helps you set up.
- [ ] **Meet [Clio](clio) (optional).** She is your planner: calendar, reminders, tasks and your week. Open [Plan my week](onboarding-thread:clio) and ask her something.
- [ ] **Fill in the [Getting Started Worksheet](onboarding:getting-started-worksheet).** Ping [Patty](patty) when it is done, and she turns your answers into your [Recommended setup](onboarding:recommended-setup) and suggests the agents to create.
- [ ] **Create your first doc, thread and table.** Use the **+** at the top of the Workspace sidebar, or use the hotkeys: **Cmd+Shift+D** creates a doc and **Cmd+Shift+T** starts a thread. See [Keyboard Shortcuts](onboarding:keyboard-shortcuts) for more.
- [ ] **Try the [ideas](onboarding-table:ideas) table.** Add your first idea.
- [ ] **Look around [My First Project (Sample)](onboarding-folder:sample-project).** It shows how a project keeps its docs and its own task table together. Edit it, or delete it when you are done.
- [ ] **Set instructions for every agent.** Open **Home**, find **Instructions for all agents**, and write what every agent should know, such as "Keep answers short." Snaglet adds it to every agent's instructions, in every thread.

## Where things are

The [Onboarding](onboarding-folder:onboarding) folder, under **Docs & context** in the sidebar, has four folders:

- [Start here](onboarding-folder:start): this page, the worksheet and your recommended setup.
- [Features](onboarding-folder:features): a short guide to each feature, from threads, docs and tables to automations, tools and backups. Its first page lists them all.
- [Reference](onboarding-folder:reference): [Using AI Responsibly](onboarding-folder:responsible-ai), a folder of notes on using AI well for each kind of work; data security; where your data lives; how to report a bug or contribute; and [Keyboard Shortcuts](onboarding:keyboard-shortcuts).
- [etc](onboarding-folder:etc): odds and ends, such as The Em Dash Propaganda.

## Getting help

Ask Patty in the [Onboarding](onboarding-thread:patty) thread. She can look things up in these docs and anywhere in your workspace. To find something yourself, press **Cmd+K** and type a few words.

**Ask Patty:** "What should I set up first?"
`,
  },
  {
    slug: 'getting-started-worksheet',
    title: 'Getting Started Worksheet',
    folder: 'start',
    body: `# Getting Started Worksheet

Welcome to Snaglet. This worksheet helps you set up your workspace based on what you want to accomplish. Fill it in at your own pace—you can always come back and update it.

**Skip any section.**

**Who reads this:** Patty reads your answers to plan your setup, so they're sent to your AI provider. See [Data Security & What to Store](onboarding:data-security).

- [Q1: What do you want to use Snaglet for?](onboarding:getting-started-worksheet#h=q1-what-do-you-want-to-use-snaglet-for)
- [Q2: What does success look like for you?](onboarding:getting-started-worksheet#h=q2-what-does-success-look-like-for-you)
- [Q3: About you](onboarding:getting-started-worksheet#h=q3-about-you)
- [Q4: What's your style?](onboarding:getting-started-worksheet#h=q4-whats-your-style)
- [Q5: How do you want your agents?](onboarding:getting-started-worksheet#h=q5-how-do-you-want-your-agents)
- [Q6: Color theme preference](onboarding:getting-started-worksheet#h=q6-color-theme-preference)
- [Extra information (optional)](onboarding:getting-started-worksheet#h=extra-information-optional)
- [Next steps](onboarding:getting-started-worksheet#h=next-steps)
- [Questions or stuck?](onboarding:getting-started-worksheet#h=questions-or-stuck)

---

## Q1: What do you want to use Snaglet for?

Check **all** that apply, then **star (★) your top 3**. Items marked 📖 have a short note worth reading first.

### Work & projects

- [ ] **Coding & technical projects** — Features, bugs, technical notes and decisions
- [ ] **Projects & tasks** — To-dos, deadlines, milestones, project plans
- [ ] **Gamify my life** — Turn chores and tasks into quests: points, streaks, levels and rewards to make them easier and more fun
- [ ] **Business planning** — Business plans, strategy, market research, pitch decks, goals and roadmaps
- [ ] **Meetings & decisions** — Notes, action items, who decided what
- [ ] **Processes & how-tos** — Checklists, templates, step-by-step guides
- [ ] **Integration orchestration** — Connect tools, sync data, trigger cross-system actions
- [ ] **Automation & monitoring** — Data pipelines, scheduled reports, news and feed roundups, monitoring your own systems, workspace maintenance · 📖 [Read first](onboarding:responsible-ai-automation)
- [ ] **Computer health** — Free up disk space, clean up files and downloads, check startup apps, updates and backups

### Research, writing & learning

- [ ] **Research & analysis** — Fact checking, trusted sources, citations, literature reviews, data analysis, source notes, investigative work, financial research, politics, news, datasets, spreadsheets · 📖 [Read first](onboarding:responsible-ai-research)
- [ ] **Web scraping & monitoring** — Watch public sites for changes: trending GitHub repos, new job postings, price drops, housing listings, new research papers · 📖 [Read first](onboarding:responsible-ai-automation)
- [ ] **Content creation** — Blog posts, articles, newsletters, social media planning · 📖 [Read first](onboarding:responsible-ai-creative)
- [ ] **Creative projects** — Writing, design, media production, portfolio work · 📖 [Read first](onboarding:responsible-ai-creative)
- [ ] **Learning & skill building** — Generate a course for me, notes, tutorials, practice projects, a personal course on any topic · 📖 [Read first](onboarding:responsible-ai-learning)
- [ ] **Teaching & tutoring** — Lesson plans, student notes, curriculum development · 📖 [Read first](onboarding:responsible-ai-teaching)
- [ ] **Personal knowledge management** — Second brain, notes, ideas, references, PDFs and files

### Personal life & people

- [ ] **Travel** — Trip planning, itineraries, packing lists, bookings, places to see
- [ ] **Home & life management** — Recipes, home improvement, chores
- [ ] **Budgeting** — Monthly budgets, spending tracking, savings goals, bills
- [ ] **Housing search** — Listings, neighborhoods, viewing notes, move checklists
- [ ] **Shopping** — Wish lists, price comparisons, product research, gift ideas
- [ ] **Music** — Discover new artists, curate playlists, learn my taste and recommend what to hear next
- [ ] **Contacts** — Networking, relationships, emails, CRM · 📖 [Read first](onboarding:responsible-ai-other-people)
- [ ] **Email & communication** — Email chains, chat logs, correspondence · 📖 [Read first](onboarding:responsible-ai-other-people)
- [ ] **Email campaign clean out** — Unsubscribe from marketing emails and newsletters, clear out promotions
- [ ] **Job search & career development** — Application tracking, networking notes, interview prep · 📖 [Read first](onboarding:responsible-ai-job-search)
- [ ] **Non-profit/community work** — Volunteer coordination, campaigns, documentation
- [ ] **Event planning** — Parties, weddings, trips with friends: timelines, vendors, guest lists, checklists
- [ ] **Health & wellness tracking** — Workout logs, meal planning, habits, questions for your doctor · 📖 [Read first](onboarding:responsible-ai-health)
- [ ] **Journaling & reflection** — Daily prompts, weekly reviews, thinking things through · 📖 [Read first](onboarding:responsible-ai-journaling)
- [ ] **Accountability & habit building** — Time management, routine tracking, goal setting, agenda planning
- [ ] **Hobby & collection management** — Track collections, project logs, equipment, techniques

### Anything else

- [ ] **One-off tasks & assistance** — Research events in town, ad-hoc help
- [ ] **Something else:**

---

## Q2: What does success look like for you?

**In 30 days, Snaglet will be valuable to me if…** Fill in as many cells as you like.

|  | Top 3 goals | Top 3 habits | Top 3 projects |
| --- | --- | --- | --- |
|  | *What you want done or changed in 30 days* | *Routines to build or keep* | *What you're working on right now* |
| *e.g.* | *Launch my portfolio site, stop missing bill due dates, learn a new skill* | *Work out 3x a week, inbox zero every Friday* | *Wedding planning, side business, learn Spanish, coding project* |
| **1** |  |  |  |
| **2** |  |  |  |
| **3** |  |  |  |

---

## Q3: About you

A little context helps agents tailor suggestions to you. Share only what you're comfortable with: answers may be remembered by agents, and you can edit or delete them any time.

### The basics

| Question | Your answer |
| --- | --- |
| **What should agents call you?** |  |
| **Where are you based?** *City or region is plenty, no street address. Helps with local events, weather and prices.* |  |
| **What language(s) should agents use?** *Include spelling and units if you care, e.g. UK spelling, metric.* |  |

### Work & school

| Question | Your answer |
| --- | --- |
| **What's your occupation or field?** |  |
| **What tools or apps do you use every day?** *e.g. Miro, Google Calendar, VS Code, Figma, Spotify, Blender* |  |
| **Are you studying anything?** *School, a course, or teaching yourself.* |  |
| **When do you usually work best?** *e.g. early mornings, late nights, weekends* |  |

### Life & interests

| Question | Your answer |
| --- | --- |
| **What are your hobbies?** |  |
| **What are you curious about or want to learn?** |  |
| **What music, books, shows or games do you like?** *Helps with recommendations.* |  |
| **What should agents know so they don't get it wrong?** *e.g. "I'm a beginner coder," "I hate long emails"* |  |

---

## Q4: What's your style?

Check the options that best describe how you naturally work. Skip any you feel neutral about.

### How you work

- [ ] **Planner** — I like structure, organization, and planning ahead.
- [ ] **Action-oriented** — I prefer taking action and figuring things out as I go.
- [ ] **Independent** — I enjoy working autonomously and figuring things out myself.
- [ ] **Collaborative** — I enjoy sharing ideas, communicating, and working with others.
- [ ] **Analytical** — I like researching, evaluating information, and thinking things through.
- [ ] **Creative** — I enjoy brainstorming, experimenting, and exploring new ideas.
- [ ] **Detail-oriented** — I focus on accuracy, precision, and getting things right.
- [ ] **Big-picture focused** — I prioritize the overall vision and long-term outcomes.
- [ ] **Adaptable** — I prefer flexibility and adjusting as situations change.
- [ ] **Results-driven** — I focus on goals, productivity, and getting things accomplished.
- [ ] **Type A** — I need consistency and structure.
- [ ] **Type B** — I am more disorganized.
- [ ] **Multitasker** — I work on several things at once.
- [ ] **Technical** — I am a technical person.
- [ ] **Non-technical** — I am not a technical person.

### How tidy you are

- [ ] **I stay tidy** — Things have a place and stay there
- [ ] **I start tidy but drift** — Nudge me back on track now and then
- [ ] **Things pile up** — Help me clean up
- [ ] **Other:**

---

## Q5: How do you want your agents?

These answers shape how your agents work with you. Check the ones that fit. Skip any you feel neutral about.

### Personality

Select all the characteristics you'd like your AI agent to embody. Skip anything you feel neutral about.

- [ ] **Analytical** — Logical, objective, and thoughtful in evaluating information.
- [ ] **Strategic** — Thinks ahead, anticipates consequences, and plans for long-term outcomes.
- [ ] **Big-picture** — Keeps the overall goal in view.
- [ ] **Intellectual** — Knowledgeable, insightful, and enjoys exploring complex ideas.
- [ ] **Proactive** — Anticipates needs, identifies opportunities, and takes initiative.
- [ ] **Decisive** — Makes confident judgments and avoids unnecessary hesitation.
- [ ] **Assertive** — Expresses opinions confidently and isn't afraid to push back.
- [ ] **Diplomatic** — Navigates disagreements tactfully and balances different perspectives.
- [ ] **Persuasive** — Influences through compelling arguments and effective communication.
- [ ] **Discerning** — Recognizes what matters and exercises sound judgment.
- [ ] **Resourceful** — Finds solutions, overcomes obstacles, and makes the most of available resources.
- [ ] **Meticulous** — Attentive to details, accuracy, and precision.
- [ ] **Adaptable** — Adjusts quickly to changing circumstances and different personalities.
- [ ] **Objective** — Remains impartial and separates facts from personal opinions.
- [ ] **Perceptive** — Recognizes underlying motivations, context, and subtle signals.
- [ ] **Psychoanalytical** — Notices patterns in how you think and act, and makes connections about what drives you.
- [ ] **Inquisitive** — Asks thoughtful questions and seeks deeper understanding.
- [ ] **Deep researcher** — Digs into sources, checks facts, and doesn't stop at the first answer.
- [ ] **Accountable** — Takes ownership of responsibilities, mistakes, and commitments.
- [ ] **Collaborative** — Builds on others' ideas and works toward shared outcomes.
- [ ] **Pragmatic** — Prioritizes realistic solutions and what actually works.
- [ ] **Candid** — Honest, straightforward, and doesn't sugarcoat the truth.
- [ ] **Composed** — Calm, measured, and steady under pressure.
- [ ] **Charismatic** — Engaging, personable, and naturally compelling.
- [ ] **Comedic** — Uses humor naturally to entertain and lighten interactions.
- [ ] **Challenging** — Pushes people to think harder and question their assumptions.
- [ ] **Encouraging** — Motivates, supports, and reinforces positive momentum.

Other personality traits:

- [ ] **Other:**
- [ ] **Other:**

**Want one agent to be different?** Name it and describe its personality.

| Agent | Personality |
| --- | --- |
| *e.g. Clio* | *Calm and encouraging* |
|  |  |

### Main priority

Pick one.

- [ ] **Balanced** — A bit of everything
- [ ] **Personality & communication** — Great to talk to
- [ ] **Strategic thinking** — Smart advice and planning
- [ ] **Getting things done** — Productivity and execution
- [ ] **Independence** — Takes initiative so I don't have to

### How agents should act

- [ ] **Act when you get the gist** — Don't make me prompt twice (agents still ask before anything hard to undo)
- [ ] **Check with me first** — Ask before making decisions
- [ ] **Take initiative** — Anticipate my needs and suggest next steps
- [ ] **Best recommendation** — Give me one pick, I'll say if it's wrong
- [ ] **All the options** — Lay out the choices so I can decide
- [ ] **Keep it simple** — Just do the task, nothing fancy
- [ ] **Fast** — Move quickly, good enough is fine
- [ ] **Thorough** — Take the time to get it right
- [ ] **Cautious** — Flag risks before moving ahead
- [ ] **Bold** — Move fast and try new things
- [ ] **Data over gut** — Back recommendations with numbers and metrics
- [ ] **Check in on me** — Reminders and check-ins to keep me on track
- [ ] **Self-starter** — I'm self-motivated, just give me the tools
- [ ] **Challenge me** — Question my assumptions, point out mistakes, critique my writing, catch typos
- [ ] **Celebrate wins** — Notice when I get things done
- [ ] **Suggest cleanups** — Flag stale or unneeded things for me to archive
- [ ] **Remember my preferences** — Learn my style over time so I don't repeat myself
- [ ] **Other:**

### How agents should talk

**Format**

- [ ] **Short** — Bullets and summaries, avoid long walls of text
- [ ] **Detailed** — Narrative explanations
- [ ] **Answer first** — Lead with the answer, details after
- [ ] **Visual** — Flowcharts for plans and processes, tables to organize information
- [ ] **Examples** — Concrete examples over abstract descriptions
- [ ] **Metaphors** — Analogies for abstract concepts
- [ ] **Other:**

**Tone**

- [ ] **Professional** — Straightforward and minimal
- [ ] **Casual** — Friendly, with humor
- [ ] **Direct** — Get to the point
- [ ] **Diplomatic** — Tactful, even with hard feedback
- [ ] **Encouraging** — Supportive and upbeat
- [ ] **Sarcastic** — Dry wit welcome
- [ ] **Roast me** — Blunt and funny, call out lazy work
- [ ] **Other:**

**Depth**

- [ ] **Plain language** — No jargon, explain like I'm new to it
- [ ] **Technical is fine** — Don't simplify
- [ ] **Teach me** — Show your reasoning, I want to get smarter
- [ ] **Other:**

**Honesty**

- [ ] **Tell me when you're unsure** — Say when you're guessing
- [ ] **Cite sources** — Link what you reference
- [ ] **No flattery** — Be honest even if I won't like it

### Models

Which models should your agents use? Leave a row blank and Patty suggests one from the providers you connected.

| For | Model |
| --- | --- |
| **Big tasks** — hard problems, long work, important writing |  |
| **Smaller tasks** — quick answers, summaries, lookups, cleanup |  |

---

## Q6: Color theme preference

Describe what kind of colors / vibe you want your workspace to look like -- describe it any way you want.

- 

---

## Extra information (optional)

Anything else Patty should know to help set up your workspace?

\\[Free text area for any additional context, specific tools you use, workflows you want to replicate, concerns, or questions\\]

---

## Next steps

Once you've filled this out, tell Patty in the [Onboarding](onboarding-thread:patty) thread. She writes your plan, with the agents she suggests, here: [Recommended setup](onboarding:recommended-setup).

---

## Questions or stuck?

Ask @Patty — she's here to help you get organized and find what you need.

**Ask Patty:** "I finished the worksheet. What do you recommend?"
`,
  },
  {
    slug: 'recommended-setup',
    title: 'Recommended setup',
    folder: 'start',
    body: `# Recommended setup

*Patty fills in this page after you finish the [Getting Started Worksheet](onboarding:getting-started-worksheet). Until then, it is a template. Everything here is a suggestion: approve, edit or skip each piece, and Patty builds only what you approve.*

## Summary

*A few short bullets of what Patty learned from your worksheet: who you are, your next 30 days, your habits, your style, any hard rules, and how you want agents to be.*

## Recommendations

*One line on what Patty suggests building now and why the rest can wait, a small diagram of the workspace, then one row per piece: projects, folders, tables, the agents she suggests, your color theme and the instructions for all agents. Mark each row Approve, Edit or Skip, and write what to change under Your notes.*

| # | Build | Why | Approve | Edit | Skip | Your notes |
| --- | --- | --- | --- | --- | --- | --- |
| *1* | *Agent: Scout, research assistant* | *Finds and checks sources for your newsletter; curious and precise* | [ ] | [ ] | [ ] |  |

**Later, only when you need them:** *what Patty left out on purpose. Reminders and habits go to [Clio](clio).*

## Instructions for every agent (optional)

*The lines Patty proposes for **Instructions for all agents** on **Home**, drafted from your answers to Q3 and Q5. They are a row in the table above: when you approve it, Patty saves them, and you approve the exact text once more in the chat. You can edit them on **Home** any time.*

## Next steps

*A short checklist of what to do first, in order, and who does each: you, Patty or Clio.*

**Ask Patty:** "Please fill in my Recommended setup from my worksheet."
`,
  },
];
