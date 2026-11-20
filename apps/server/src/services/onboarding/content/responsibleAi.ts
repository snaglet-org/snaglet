import type { OnboardingDocSource } from './types';

/**
 * The "Using AI Responsibly" folder inside the Reference folder, in sidebar
 * order: its overview first, then a note for each kind of work.
 */
export const RESPONSIBLE_AI_DOCS: readonly OnboardingDocSource[] = [
  {
    slug: 'using-ai-responsibly',
    title: 'Using AI Responsibly',
    folder: 'responsible-ai',
    body: `# Using AI Responsibly

Agents are good helpers, but they can be wrong, sound sure when they aren't, and miss context only you have. Use them to think, organize and check, not to replace your own judgment or a qualified professional.

## The basics

- **Check what matters.** Verify facts, numbers, quotes and citations against the original source before you rely on them.
- **You're responsible for the result.** Whatever you publish, submit or act on is yours, not the agent's.
- **Protect other people.** Don't store or share someone else's private information without their permission. See [Data Security & What to Store](onboarding:data-security).

## Notes by kind of work

- [Research & analysis](onboarding:responsible-ai-research): fact checking, trusted sources, citations, politics, news and financial research
- [Health & wellness](onboarding:responsible-ai-health): tracking habits without replacing a doctor
- [Teaching & tutoring](onboarding:responsible-ai-teaching): lesson prep and keeping student details safe
- [Journaling & reflection](onboarding:responsible-ai-journaling): reflecting with an agent without treating it as a therapist
- [Creative projects](onboarding:responsible-ai-creative): using AI as a tool for your own creativity, not a slop machine
- [Learning & skill building](onboarding:responsible-ai-learning): AI-made courses and checking what you learn
- [Job search & career](onboarding:responsible-ai-job-search): honest applications and careful networking notes
- [Automation & monitoring](onboarding:responsible-ai-automation): watching systems, not people, and respecting websites
- [Other people's information](onboarding:responsible-ai-other-people): contacts, emails, chat logs and meeting notes

## Health and medical

Agents can help you log workouts, plan meals or prepare questions for a doctor. They can't diagnose you, prescribe anything or replace medical care. For symptoms, medication or mental health concerns, talk to a qualified professional. In an emergency, call your local emergency number.

## Legal

Agents can help you organize notes, summarize documents and prepare questions. They are not lawyers, and they can't give legal advice. Laws differ by place and change over time. Have a qualified lawyer review anything with real consequences.

## Money and investing

Agents can help you track a budget, take notes on research or compare options. They are not financial advisors and can't predict markets. Check figures yourself, and talk to a licensed professional before big financial decisions.

## Research and analysis

Use agents to find and check sources, fact check claims, organize notes and understand material.

- **Confirm every fact with a trusted, primary source.** Agents sometimes invent citations, quotes and numbers, so don't trust one until you've found it yourself.
- **Don't pass off AI-written work as your own.** Follow your school's, publisher's or outlet's rules on AI use, and say when you used it if your audience expects that.
- **Never publish AI-generated quotes.** Quote people only from what they actually said.

## People and personal data

Don't use agents to profile, monitor or make decisions about specific people, like hiring, grading, renting or lending. Keep student, client and patient details out unless you have permission and your setup meets the rules that apply.

**Ask Patty:** "Is this a good thing to use AI for?"
`,
  },
  {
    slug: 'responsible-ai-research',
    title: 'Responsible AI: Research & analysis',
    folder: 'responsible-ai',
    body: `# Responsible AI: Research & analysis

Agents are great at finding sources, summarizing material and spotting gaps. They also make things up with total confidence. Use them to speed up research, not to replace checking it.

## Good uses

- Finding and organizing sources, notes and citations
- Summarizing papers, articles and reports so you know what to read closely
- Fact checking a claim and pointing you to where it came from
- Comparing viewpoints and listing open questions

## Do it responsibly

- **Confirm every fact with a trusted, primary source.** Agents sometimes invent citations, quotes, numbers and links. Don't trust one until you've opened it yourself.
- **Prefer trusted sources.** Peer-reviewed work, official data and reputable outlets beat a random blog or a model's memory. Note where each fact came from.
- **Don't pass off AI-written work as your own.** Follow your school's, publisher's or outlet's rules on AI use, and say when you used it if your audience expects that.
- **Never publish AI-generated quotes.** Quote people only from what they actually said.
- **Politics and news:** look at more than one side, check the date, and be wary of anything that confirms what you already believe a little too neatly.
- **Financial research:** agents can't predict markets and aren't financial advisors. Check figures against the source and talk to a licensed professional before big decisions.

**Ask Patty:** "Help me set up a research project with a sources table."

Back to [Using AI Responsibly](onboarding:using-ai-responsibly).
`,
  },
  {
    slug: 'responsible-ai-health',
    title: 'Responsible AI: Health & wellness',
    folder: 'responsible-ai',
    body: `# Responsible AI: Health & wellness

Agents can help you build healthy routines and keep track of how you're doing. They are not doctors.

## Good uses

- Logging workouts, meals, sleep and habits
- Planning meals and grocery lists
- Setting goals and reminders
- Writing down questions to bring to your doctor

## Do it responsibly

- **No diagnosis, no prescriptions.** Agents can't diagnose you, recommend medication or replace medical care. For symptoms, medication or mental health concerns, talk to a qualified professional.
- **In an emergency, call your local emergency number.** Don't ask an agent first.
- **Keep identifying medical records out.** Notes on your own habits are fine; full records with ID numbers are not. See [Data Security & What to Store](onboarding:data-security).
- **Be kind to yourself.** If tracking food, weight or exercise starts to feel stressful, pause it and talk to someone you trust.

**Ask Patty:** "Help me set up a habit tracker."

Back to [Using AI Responsibly](onboarding:using-ai-responsibly).
`,
  },
  {
    slug: 'responsible-ai-teaching',
    title: 'Responsible AI: Teaching & tutoring',
    folder: 'responsible-ai',
    body: `# Responsible AI: Teaching & tutoring

Agents can save you hours on lesson prep. Student information needs extra care.

## Good uses

- Drafting lesson plans, worksheets and practice questions
- Organizing curriculum and resources
- Explaining a topic several ways so you can pick what fits

## Do it responsibly

- **Keep student details out.** Don't store names, grades or personal information about students unless you have permission and your setup meets your school's rules. Use initials or general notes instead.
- **Don't let an agent grade or judge students.** Decisions about a student are yours to make.
- **Check what you teach.** Review AI-made material for accuracy before it reaches a student.
- **Follow your school's AI policy**, and help students learn to use AI honestly too.

**Ask Patty:** "Help me set up a lesson planning folder."

Back to [Using AI Responsibly](onboarding:using-ai-responsibly).
`,
  },
  {
    slug: 'responsible-ai-journaling',
    title: 'Responsible AI: Journaling & reflection',
    folder: 'responsible-ai',
    body: `# Responsible AI: Journaling & reflection

Agents can help you build a journaling habit, spot patterns and think things through. They are not therapists.

## Good uses

- Daily or weekly prompts to get you writing
- Looking back over entries to notice patterns, wins and what's changed
- Gratitude lists, goal reviews and end-of-week reflections
- Talking a decision or a tough day through to get some clarity

## Do it responsibly

- **An agent isn't a therapist.** It can listen and reflect back, but it can't treat anxiety, depression or trauma. If you're struggling, talk to a counselor, doctor or someone you trust.
- **If you're in crisis, reach out to a person now.** Call your local emergency number or a crisis line (in the US, call or text **988**).
- **Remember who reads it.** What you write goes to your agent's model provider. Keep deeply private details out, or use a local model. See [Data Security & What to Store](onboarding:data-security).
- **Keep other people's private details out.** Write about how things affected you rather than recording someone else's secrets.
- **Trust your own judgment.** Use the agent's reflections as a prompt to think, not as the final word on you.

**Ask Patty:** "Help me set up a journal with a weekly reflection prompt."

Back to [Using AI Responsibly](onboarding:using-ai-responsibly).
`,
  },
  {
    slug: 'responsible-ai-creative',
    title: 'Responsible AI: Creative projects',
    folder: 'responsible-ai',
    body: `# Responsible AI: Creative projects

Creativity is human. Use agents as a tool that supports your ideas, your voice and your craft, not as a machine that churns out content for you.

## Good uses

- Brainstorming when you're stuck, then picking and shaping the ideas yourself
- Keeping track of characters, worlds, drafts, references and project notes
- Feedback on your work: pacing, clarity, consistency, typos
- Planning a project: timelines, shot lists, chapter outlines, portfolio pieces
- Learning a technique or the history behind a style

## Do it responsibly

- **Keep your voice at the center.** Let the agent ask questions, suggest and critique, but make the creative choices yourself. Your perspective is the part no model can supply.
- **Don't make slop.** Mass-produced, low-effort AI content crowds out real work. If you wouldn't stand behind it as yours, don't publish it.
- **Respect other artists.** Don't ask an agent to copy a living artist's or writer's style to pass as theirs, or to reproduce someone's work. Credit your influences and sources.
- **Be honest about AI use.** Say when AI played a real part in a piece, especially for contests, clients, publishers or communities that ask. Follow their rules.
- **Check the rights.** Copyright and AI rules vary by place and platform. Check before you sell or submit work that AI helped make.
- **Keep practicing.** Use the agent to grow your skills, not to replace them.

**Ask Patty:** "Help me set up a creative project with a drafts folder and an ideas table."

Back to [Using AI Responsibly](onboarding:using-ai-responsibly).
`,
  },
  {
    slug: 'responsible-ai-learning',
    title: 'Responsible AI: Learning & skill building',
    folder: 'responsible-ai',
    body: `# Responsible AI: Learning & skill building

Agents make great study partners: patient, available any time and happy to explain things five different ways. They can also teach you something wrong with total confidence.

## Good uses

- Building a personal course on any topic, with lessons, practice and review
- Explaining a hard idea in simpler words, or with an example
- Quizzing you and tracking what you've mastered
- Organizing course notes, tutorials and practice projects

## Do it responsibly

- **Check facts against real sources.** An AI-made course can sound polished and still be wrong. Look things up in a textbook, official docs or a trusted site, especially for anything technical, medical, legal or historical.
- **Ask for sources.** Have the agent point to where its information comes from, then open the source yourself.
- **Do the work yourself.** Let the agent quiz you and give hints, not hand over answers. You learn by struggling a little.
- **Follow your school's rules.** If a class has an AI policy, stick to it. Don't submit AI-written work as your own.

**Ask Patty:** "Help me build a personal course on a topic I want to learn."

Back to [Using AI Responsibly](onboarding:using-ai-responsibly).
`,
  },
  {
    slug: 'responsible-ai-automation',
    title: 'Responsible AI: Automation & monitoring',
    folder: 'responsible-ai',
    body: `# Responsible AI: Automation & monitoring

Automations let agents work while you're away. That power is great for your own work, and needs care when it touches other people or websites.

## Good uses

- Scheduled reports and summaries of your own work
- Watching your own systems, servers or projects and flagging problems
- Gathering news or updates from feeds and sources you subscribe to
- Keeping your workspace tidy on a schedule

## Do it responsibly

- **Monitor systems, not people.** Don't use automations to track, watch or report on specific people without their knowledge.
- **Respect websites' rules.** Check a site's terms before you collect content from it automatically, prefer official feeds or APIs, and don't hammer it with requests.
- **Respect copyright.** Summarize and link to what you gather; don't republish other people's work as your own.
- **Keep a human in the loop.** For anything that sends messages, spends money or deletes things, have the agent ask first. See [Tools and scripts](onboarding:tools-and-scripts).
- **Check in on it.** Review what your automations are doing now and then, and turn off any you no longer need.

**Ask Patty:** "Help me set up a weekly summary of my workspace."

Back to [Using AI Responsibly](onboarding:using-ai-responsibly).
`,
  },
  {
    slug: 'responsible-ai-other-people',
    title: "Responsible AI: Other people's information",
    folder: 'responsible-ai',
    body: `# Responsible AI: Other people's information

Contacts, emails, chat logs and meeting notes are full of other people's names, words and details. They didn't sign up for your workspace, so treat their information with care.

## Good uses

- Keeping notes on people you work with so you remember to follow up
- Summarizing a long email chain or meeting into decisions and action items
- Tracking contacts for a project, event or job search

## Do it responsibly

- **Keep only what you need.** A name, how you met and what to follow up on is usually enough. Leave out private details people shared in confidence.
- **Remember where it goes.** Anything your agents read is sent to their model provider. Think twice before pasting someone else's private messages. See [Data Security & What to Store](onboarding:data-security).
- **Ask before you share.** Don't forward or publish someone's messages, photos or personal details without their permission.
- **Don't profile people.** Don't use agents to dig up, compile or judge personal information about specific people, or to make decisions about them like hiring, renting or lending.
- **Respect rules you're bound by.** Work, client or customer data may be covered by contracts or privacy laws. Check before you store it.
- **Clean up.** Delete notes and logs you no longer need.

**Ask Patty:** "Help me set up a simple contacts table."

Back to [Using AI Responsibly](onboarding:using-ai-responsibly).
`,
  },
  {
    slug: 'responsible-ai-job-search',
    title: 'Responsible AI: Job search & career',
    folder: 'responsible-ai',
    body: `# Responsible AI: Job search & career

Agents can make a job search much less painful. Keep it honest, and keep it about you.

## Good uses

- Tracking applications, deadlines and follow-ups in a table
- Practicing interview questions and getting feedback on your answers
- Tailoring your resume and cover letter to a role
- Researching companies and preparing questions to ask them

## Do it responsibly

- **Stay truthful.** Let the agent polish your words, never invent experience, skills, titles or dates. If it's on your resume, you should be able to talk about it.
- **Sound like you.** Edit AI drafts until they're in your own voice. Recruiters notice generic, copy-paste letters.
- **Follow the rules on AI.** Some employers ask whether you used AI, or ban it in tests and take-home tasks. Respect that, and never use AI to answer for you in a live interview.
- **Be careful with networking notes.** Notes about people you meet are their information too. Keep it to what you need to follow up, and leave out private details they shared in confidence. See [Other people's information](onboarding:responsible-ai-other-people).

**Ask Patty:** "Help me set up a job application tracker."

Back to [Using AI Responsibly](onboarding:using-ai-responsibly).
`,
  },
];
