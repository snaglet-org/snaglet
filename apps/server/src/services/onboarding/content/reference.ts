import type { OnboardingDocSource } from './types';

/** The "Reference" folder inside the Onboarding folder, in sidebar order. */
export const REFERENCE_DOCS: readonly OnboardingDocSource[] = [
  {
    slug: 'data-security',
    title: 'Data Security & What to Store',
    folder: 'reference',
    body: `# Data Security & What to Store

Snaglet keeps your workspace on your computer, but your agents talk to AI models, and those models see what agents send them. Be thoughtful about what you put in, and about what comes back from outside.

## Everything in Snaglet is stored locally

- Everything Snaglet stores is in your [Snaglet home folder](onboarding:where-your-data-lives) (\`~/.snaglet\` for the app): a database Snaglet runs for you, plus backups, images, skills, hooks, logs and downloaded models.
- Snaglet has no account, no Snaglet server and no telemetry.
- Provider and MCP keys you enter in their own settings are encrypted before they are saved, with a key kept in your Snaglet home.

## What leaves your computer

- Your messages, and whatever an agent reads for its turn, go to the model provider that agent uses. Local providers keep them on your Mac.
- Web searches, web pages and the browser, when agents use them.
- MCP servers you add, which may talk to outside services.
- Model downloads (the embedding model, and voices when you ask), a daily check for a newer version of Snaglet, and the update itself when you install one.

## Good things to keep in Snaglet

- Work notes, plans, meeting notes and decisions
- Tasks, projects and timelines
- Research, references and ideas
- Writing drafts and learning notes
- Personal planning: goals, habits and routines

## Things to keep out

- Passwords, API keys and other secrets in docs, tables or messages. Anything you paste there is plain text that agents can read and send to their provider. Keep secrets in a password manager.
- Government ID numbers, full bank or card numbers, and raw financial statements.
- Medical records with identifying details.
- Data you must protect by contract or law, unless you know your setup meets those rules.

## Other people's information

Contacts, notes about people, and data about anyone other than you (friends, family, clients, colleagues, customers) belong to them too. Keep it respectful:

- Store information about other people only if they would reasonably expect you to have it, or they have agreed to it. Your own address book and your own notes about a conversation are fine; copying someone's private details, records or messages into Snaglet without their consent is not.
- Remember that agents send what they read to a model provider. For other people's data, prefer a local provider, or leave out what the task does not need: names, contact details, health, money and anything sensitive.
- Never keep other people's government IDs, financial account numbers or medical details here.
- Customer or client data may carry legal or contractual duties. Check them before putting it in your workspace.
- Contacts and people tables, CRM rows and notes about relationships follow the same rule. See [Tables](onboarding:tables) for keeping them organized.

## Snaglet flags outside content as untrusted to prevent prompt injection

Web pages and search results reach agents marked as untrusted outside content, and agents are told to treat them as information, never as instructions. Do the same with anything from the web or from an MCP server you add: check it before you act on it.

## Protect your computer, best practices

- Turn on your computer's disk encryption and use a strong login password.
- Back up your Snaglet home folder, including \`credential.key\`. See [Backups](onboarding:backups).
- Don't keep the Snaglet home in a cloud-sync folder: syncing a running database can damage it.
- Agents act with your user account's permissions. Keep risky tools on "ask first" unless you trust the agent; see [Tools and scripts](onboarding:tools-and-scripts).

**Ask Patty:** "What should I avoid storing in Snaglet?"
`,
  },
  {
    slug: 'where-your-data-lives',
    title: 'Where your data lives',
    folder: 'reference',
    body: `# Where your data lives

Everything Snaglet stores is in one folder, the Snaglet home: \`~/.snaglet\` for the app. Its name starts with a dot, so Finder hides it. To open it, choose **Go → Go to Folder…** in Finder and type \`~/.snaglet\`.

## What is inside

| Item | What it holds |
| --- | --- |
| \`postgres\` | The database: docs, threads, messages, tables, memories, agents and settings |
| \`backups\` | Snapshots of the database |
| \`images\` | Images you add and pictures agents take |
| \`skills\` | Your skills, one folder each |
| \`hooks\` | Your hooks, one folder each |
| \`tools\` | Your custom tools |
| \`projects\` | One shortcut per project to the folder it links |
| \`models\` | Downloaded models for search and voice |
| \`logs\` | Logs, including \`server.log\` |
| \`credential.key\` | The key that encrypts your saved provider and MCP credentials |
| \`pg-password\` and the other \`pg-…-password\` files | Passwords for the database |
| Everything else | Files Snaglet manages for itself |

## Leave these alone

- Don't edit or move anything in \`postgres\` while Snaglet runs.
- Never delete \`credential.key\`: saved credentials can't be read without it.

## Back it up

See [Backups](onboarding:backups). Keep \`credential.key\` with any copy of your data.

## Move it

**Settings → Local storage** moves the Snaglet home; see [Local storage and models](onboarding:local-storage-and-models). If you moved it, \`~/.snaglet.json\` records where it is.

## Not in this folder

- Folders you link to projects stay where they are.
- What agents send to model providers leaves your Mac. See [Data Security & What to Store](onboarding:data-security).

Don't keep the Snaglet home in a cloud-sync folder: syncing a running database can damage it.

**Ask Patty:** "What is in my Snaglet home folder?"
`,
  },
  {
    slug: 'contributing',
    title: 'Contributing',
    folder: 'reference',
    body: `# Contributing

Snaglet is open source. Bug reports, ideas and code are all welcome.

## Report a bug

Open an issue on [the issue tracker](https://github.com/snaglet-org/snaglet/issues). It helps to include:

- your macOS version and your Snaglet version (**Settings → Updates** shows it)
- the steps that cause the problem
- what you expected, and what happened instead
- the relevant lines of \`logs/server.log\` in your Snaglet home (\`~/.snaglet\` for the app)

Check the log for anything private before you paste it.

## Suggest an idea

Open an issue on [the issue tracker](https://github.com/snaglet-org/snaglet/issues) and describe what you are trying to do. A real example of the work you want to get done is more useful than a feature name.

## Contribute code or docs

The source is at [github.com/snaglet-org/snaglet](https://github.com/snaglet-org/snaglet). Read [CONTRIBUTING.md](https://github.com/snaglet-org/snaglet/blob/main/CONTRIBUTING.md) first: it covers setup, the checks to run and how to open a pull request.

## Report a security problem

Do not open a public issue. Follow [SECURITY.md](https://github.com/snaglet-org/snaglet/blob/main/SECURITY.md).

**Ask Patty:** "How do I report a bug in Snaglet?"
`,
  },
  {
    slug: 'keyboard-shortcuts',
    title: 'Keyboard Shortcuts',
    folder: 'reference',
    body: `# Keyboard Shortcuts

On Windows and Linux, use Ctrl for Cmd and Alt for Option.

## Getting around panes

Each pane keeps its own history of the places you opened in it. These keys act on the focused pane: the one you last clicked or moved to.

| Shortcut | What it does in the focused pane |
| --- | --- |
| **Cmd+[** / **Cmd+]** | Back / forward, also while you type |
| **Cmd+Y** | Open Recently visited (not while typing: there Cmd+Y is redo) |
| **Cmd+Up** | Open the folder or project holding the item (not while typing) |
| **Cmd+Option+Left/Right/Up/Down** | Move to the pane on that side; focus returns to where it was in it |
| **Ctrl+Tab** / **Ctrl+Shift+Tab** | Move to the next / previous pane |

In **Recently visited**: **Up** and **Down** (or **Home** and **End**) move, **Enter** opens the place in this pane, **Cmd+Enter** or Cmd-click opens it in a new pane beside this one, **1** to **9** open that row, typing a name jumps to it, and **Esc** closes the menu and puts you back where you were.

## Create

| Shortcut | What it does |
| --- | --- |
| **Cmd+Shift+D** | Create a doc and open it (works while you type, too) |
| **Cmd+Shift+C** | Create a container and open it |
| **Cmd+Shift+T** | Start a thread: pick its agents, then it opens |

All three are made at the workspace level, outside any project. In a browser tab, where the browser keeps some of these keys, use **Ctrl** instead of **Cmd**.

## Search and find

| Shortcut | What it does |
| --- | --- |
| **Cmd+K** | Search everything |
| **Cmd+F** | Find in the open doc or thread. In a doc it can also replace; in a table it jumps to the table's search box |

In **Cmd+K**, type a prefix to narrow the search: \`doc:\`, \`thread:\`, \`message:\`, \`table:\`, \`entry:\` (table rows), \`agent:\`, \`memory:\`, \`tool:\`, \`image:\`, \`container:\` or \`project:\`, \`summary:\` (thread summaries), and \`file:\` or \`folder:\` (linked project folders).

## App

| Shortcut | What it does |
| --- | --- |
| **Cmd+R** | Reload the interface, the same as **Reload UI** in the status bar. Your data and running work are untouched |
| **Cmd+B** | Show or hide the sidebar (not while typing) |
| **Cmd+=** / **Cmd+-** | Zoom in / out |
| **Cmd+0** | Reset zoom to 100% |

## Docs

| Shortcut | Turns the selection into |
| --- | --- |
| **Cmd+Option+0** | Text |
| **Cmd+Option+1** to **3** | Heading 1 to 3 |
| **Cmd+Shift+8** | Bullet list |
| **Cmd+Shift+7** | Numbered list |
| **Cmd+Shift+9** | Task list |
| **Cmd+Shift+B** | Quote |
| **Cmd+Option+C** | Code block |
| **Cmd+B** | Bold |
| **Cmd+I** | Italic |
| **Cmd+Shift+S** | Strikethrough |
| **Cmd+E** | Inline code |

| Shortcut | What it does |
| --- | --- |
| **Shift+Enter** | Start a new line inside the same paragraph |
| **Backspace** or **Cmd+Z** | Right after Snaglet formats what you typed: undo the formatting, keep your text |
| **/** | Block commands |
| **@** | Link a doc, thread, table, row, agent or file |

## Tables

| Shortcut | What it does |
| --- | --- |
| **Cmd+Shift+N** | Add a row |
| **Cmd+C**, then **Cmd+V** | Duplicate the checked rows |
| **Cmd+Z** / **Cmd+Shift+Z** | Undo / redo your table changes |
| **Escape** | Undo the edit in the cell you are changing |

## Calendar

| Shortcut | What it does |
| --- | --- |
| **Cmd+Z** | Undo your last change while the Calendar is active |
| **Cmd+scroll** or pinch | Zoom in and out in Week and Day views |

## Images

| Shortcut | What it does |
| --- | --- |
| **F2** | Rename the image selected in the Workspace tree |

**Ask Patty:** "Which shortcuts should I learn first?"
`,
  },
];
