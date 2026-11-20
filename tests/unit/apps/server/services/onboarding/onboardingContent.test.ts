/**
 * The starter docs and the starter agents' prompts that ship with Snaglet:
 * every doc opens with an H1 equal to its title (a doc transcluded whole
 * reads in place without one), every seed link names something the seed
 * creates, every heading link lands on a heading, and nothing personal, no
 * other product's name and no retired name slips into a new install.
 */
import {
  ONBOARDING_DOCS,
  ONBOARDING_FOLDERS,
  SAMPLE_PROJECT_DOCS,
} from '@server/services/onboarding/content';
import {
  AGENT_INSTRUCTION_DOCS,
  IDENTITY_SECTION,
  SYSTEM_PROMPT_HEADING,
  SYSTEM_PROMPT_SECTION,
  agentDesignTitle,
  agentFolder,
} from '@server/services/onboarding/content/agentInstructions';
import type { OnboardingDocSource } from '@server/services/onboarding/content/types';
import { STARTER_AGENTS, starterAgentDefaults } from '@server/services/onboarding/starterAgents';
import { NO_SEED_IDS, resolveSeedLinks } from '@server/services/onboarding/seedLinks';
import {
  docHeadings,
  parseInDocHeadingHref,
  resolveDocAnchor,
  sliceDocAnchor,
} from '@snaglet/shared/utils';
import { SETTINGS_ENTRY_LABELS } from '@snaglet/shared/constants/settingsEntries';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const ALL_DOCS = [...ONBOARDING_DOCS, ...SAMPLE_PROJECT_DOCS, ...AGENT_INSTRUCTION_DOCS];

function agentDoc(slug: string): OnboardingDocSource {
  const doc = AGENT_INSTRUCTION_DOCS.find((candidate) => candidate.slug === slug);
  if (!doc) throw new Error(`No agent doc ${slug}`);
  return doc;
}
const designDoc = (agentId: string) => agentDoc(`${agentId}-agent-design`);
const indexDoc = (agentId: string) => agentDoc(`${agentId}-context-index`);
/** A doc's text from its first `## ` heading on: what follows the note to the user. */
const sections = (body: string) => body.slice(body.indexOf('\n## ') + 1);

/** A doc's `## <heading>` section, the way an agent field's `#h=` transclusion slices it. */
function section(body: string, slug: string): string | null {
  return sliceDocAnchor(body, { heading: { slug } }).text;
}
const SLUGS = new Set(ALL_DOCS.map((doc) => doc.slug));
/** Docs another seeded doc transcludes whole (`![](onboarding:<slug>)`); they read in place. */
const TRANSCLUDED = new Set(
  ALL_DOCS.flatMap((doc) =>
    [...doc.body.matchAll(/!\[\]\(onboarding:([a-z0-9-]+)\)/g)].map(([, slug]) => slug!)
  )
);
/** The guides: every Onboarding doc but the etc folder's and the transcluded ones. */
const GUIDES = ONBOARDING_DOCS.filter((doc) => doc.folder !== 'etc' && !TRANSCLUDED.has(doc.slug));
const RESPONSIBLE_AI_INDEX = 'using-ai-responsibly';
const BACK_TO_RESPONSIBLE_AI = `Back to [Using AI Responsibly](onboarding:${RESPONSIBLE_AI_INDEX}).`;
const FOLDERS = new Set([
  'onboarding',
  ...ONBOARDING_FOLDERS.map((folder) => folder.key),
  'sample-project',
  'agents',
  ...STARTER_AGENTS.map((agent) => agentFolder(agent.id)),
]);
const TABLES = new Set(['ideas', 'tasks', 'events', 'reminders', 'sample-tasks']);
const THREADS = new Set(['patty', 'clio']);
const AGENT_LINKS = new Set(['patty', 'clio']);
const WEB_LINKS = new Set([
  'https://github.com/snaglet-org/snaglet',
  'https://github.com/snaglet-org/snaglet/issues',
  'https://github.com/snaglet-org/snaglet/blob/main/CONTRIBUTING.md',
  'https://github.com/snaglet-org/snaglet/blob/main/SECURITY.md',
]);
/** The guides in the Features folder, after its index. Their slugs stay stable: links use them. */
const FEATURE_GUIDES = [
  'threads-and-agents',
  'docs-and-the-editor',
  'tables',
  'calendar-and-reminders',
  'projects-and-folders',
  'search',
  'hooks-and-automations',
  'mcp',
  'skills',
  'tools-and-scripts',
  'memory',
  'voice',
  'browser',
  'command-line',
  'images-and-files',
  'local-storage-and-models',
  'embeddings',
  'backups',
  'providers-and-credentials',
];

const SEED_LINK = /\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)/g;

/** Whether `fragment` (after `#`) names a heading of the seeded doc `slug`. */
function headingOf(slug: string, fragment: string): boolean {
  const ref = parseInDocHeadingHref(`#${fragment}`);
  const body = ALL_DOCS.find((doc) => doc.slug === slug)?.body;
  if (!ref || !body) return false;
  const found = resolveDocAnchor(body, { heading: ref });
  return Boolean(found.lines) && !found.note;
}

/** A doc's links to its own headings (`[label](#…)`), as label and href. */
function inDocLinks(body: string): Array<[label: string, href: string]> {
  return [...body.matchAll(SEED_LINK)]
    .filter(([, , target]) => target!.startsWith('#'))
    .map(([, label, target]) => [label!, target!]);
}

/** Everything a new user reads: doc bodies and the agents' prompts and personas. */
const TEXTS: Array<{ where: string; text: string; isDoc?: boolean }> = [
  ...ALL_DOCS.map((doc) => ({ where: doc.slug, text: doc.body, isDoc: true })),
  ...STARTER_AGENTS.flatMap((agent) => [
    { where: `${agent.id} prompt`, text: agent.systemPrompt },
    { where: `${agent.id} identity`, text: agent.identity },
  ]),
];

/** Names that must not appear in seeded content, including other products. */
const BANNED =
  /\b(?:HQ|Venus|Ind[i]go|DuckDuckGo|1Password|Bitwarden|LastPass|FileVault|BitLocker|LUKS|Slack|Notion|Obsidian|Dropbox|iCloud|OneDrive|Google Drive|Trello|Asana|Jira|Zapier)\b/;
/** The worksheet's examples of tools a person may already use: the only other products named. */
const TOOL_EXAMPLES = '*e.g. Miro, Google Calendar, VS Code, Figma, Spotify, Blender*';
/** Provider names belong in the providers guide only. */
const PROVIDER_NAMES =
  /\b(?:Anthropic|OpenAI|Gemini|Mistral|DeepSeek|xAI|Grok|Together AI|Copilot|Ollama|LM Studio|Apple On-Device|Claude|Codex|ChatGPT)\b/;
const PERSONAL = [
  /\/Users\/[^\s/`'")\]]+/,
  /\/home\/[a-z][^\s/]*/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /\b(?:doc|thread|container|table|message|memory)-\d{13}-[a-z0-9]{9}\b/,
  /\.snaglet-dev/,
];

describe('starter docs', () => {
  it('has a welcoming number of guides, each slug and title unique', () => {
    expect(ONBOARDING_DOCS.length).toBeGreaterThanOrEqual(12);
    expect(ONBOARDING_DOCS.length).toBeLessThanOrEqual(40);
    expect(SLUGS.size).toBe(ALL_DOCS.length);
    expect(new Set(ALL_DOCS.map((doc) => doc.title)).size).toBe(ALL_DOCS.length);
    for (const doc of ALL_DOCS) expect(doc.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it('starts every doc with an H1 equal to its title, except the one transcluded whole', () => {
    expect([...TRANSCLUDED]).toEqual(['transclusion-example']);
    for (const doc of ALL_DOCS) {
      if (TRANSCLUDED.has(doc.slug)) {
        // It shows inside another doc, so a title of its own would show there too.
        expect(doc.body.match(/^# /gm)).toBeNull();
        continue;
      }
      expect(doc.body.split('\n')[0]).toBe(`# ${doc.title}`);
      // One H1 only.
      expect(doc.body.match(/^# /gm)).toHaveLength(1);
    }
  });

  it('puts the Welcome doc first and keeps it to Start here, Keyboard Shortcuts, folders, agents and threads', () => {
    expect(ONBOARDING_DOCS[0]?.slug).toBe('welcome-to-snaglet');
    const welcome = ONBOARDING_DOCS[0]!.body;
    const startHere = new Set([
      ...ONBOARDING_DOCS.filter((doc) => doc.folder === 'start').map((doc) => doc.slug),
      'keyboard-shortcuts',
    ]);
    for (const [, , target] of welcome.matchAll(SEED_LINK)) {
      const [scheme, key] = target!.split(':');
      if (scheme === 'onboarding') expect(startHere.has(key!)).toBe(true);
    }
  });

  it('has four folders in Onboarding and the Using AI Responsibly folder inside Reference', () => {
    expect(ONBOARDING_FOLDERS).toEqual([
      { key: 'start', name: 'Start here' },
      { key: 'features', name: 'Features' },
      { key: 'reference', name: 'Reference' },
      { key: 'responsible-ai', name: 'Using AI Responsibly', parent: 'reference' },
      { key: 'etc', name: 'etc' },
    ]);
    for (const folder of ONBOARDING_FOLDERS) {
      expect(ONBOARDING_DOCS.some((doc) => doc.folder === folder.key)).toBe(true);
    }
  });

  it('keeps every feature guide in one Features folder that opens with an index of them', () => {
    const features = ONBOARDING_DOCS.filter((doc) => doc.folder === 'features');
    expect(features[0]).toMatchObject({ slug: 'features-index', title: 'Features' });
    // The example Docs and the editor transcludes comes last and is not a guide.
    expect(features[features.length - 1]?.slug).toBe('transclusion-example');
    const guides = features
      .slice(1)
      .filter((doc) => !TRANSCLUDED.has(doc.slug))
      .map((doc) => doc.slug);
    expect([...guides].sort()).toEqual([...FEATURE_GUIDES].sort());
    // The index links each guide once, in the folder's order.
    const linked = [...features[0]!.body.matchAll(SEED_LINK)].map(([, , target]) => target);
    expect(linked).toEqual(guides.map((slug) => `onboarding:${slug}`));
  });

  it('ends every guide with a question to ask Patty or Clio', () => {
    expect(GUIDES.length).toBe(ONBOARDING_DOCS.length - 2);
    for (const doc of GUIDES) {
      let body = doc.body.trimEnd();
      // A responsible-use note then leads back to its overview.
      if (doc.folder === 'responsible-ai' && doc.slug !== RESPONSIBLE_AI_INDEX) {
        expect(body.endsWith(`\n\n${BACK_TO_RESPONSIBLE_AI}`)).toBe(true);
        body = body.slice(0, -BACK_TO_RESPONSIBLE_AI.length).trimEnd();
      }
      expect(body).toMatch(/\*\*Ask (?:Patty|Clio):\*\* "[^"]+"$/);
    }
  });

  it('opens Using AI Responsibly with an overview that links each note once', () => {
    const notes = ONBOARDING_DOCS.filter((doc) => doc.folder === 'responsible-ai');
    expect(notes[0]?.slug).toBe(RESPONSIBLE_AI_INDEX);
    const linked = [...notes[0]!.body.matchAll(SEED_LINK)]
      .map(([, , target]) => target!)
      .filter((target) => target.startsWith('onboarding:responsible-ai-'));
    expect(linked.sort()).toEqual(
      notes
        .slice(1)
        .map((doc) => `onboarding:${doc.slug}`)
        .sort()
    );
  });

  it('links only to things the seed creates, agents, the issue tracker and own headings', () => {
    for (const { where, text, isDoc } of TEXTS) {
      for (const [, label, target] of text.matchAll(SEED_LINK)) {
        const [scheme, rest] = target!.split(/:(.*)/s);
        const [key, fragment] = (rest ?? '').split('#');
        const ok =
          // A doc link may name one of that doc's headings.
          (scheme === 'onboarding' &&
            SLUGS.has(key!) &&
            (fragment === undefined || headingOf(key!, fragment))) ||
          (scheme === 'onboarding-folder' && FOLDERS.has(rest!)) ||
          (scheme === 'onboarding-table' && TABLES.has(rest!)) ||
          (scheme === 'onboarding-thread' && THREADS.has(rest!)) ||
          AGENT_LINKS.has(target!) ||
          WEB_LINKS.has(target!) ||
          // A doc may link its own headings; a prompt has none to link.
          (isDoc === true && parseInDocHeadingHref(target!) !== null);
        if (!ok) throw new Error(`${where}: link "${label}" points at ${target}`);
      }
    }
  });

  it('names only tools that exist when it tells an agent to use one', () => {
    const toolsDir = join(
      __dirname,
      '../../../../../../apps/server/src/services/ToolService/tools'
    );
    const ids = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === 'definition.ts') {
          const id = /\bid: '([a-z_]+)'/.exec(readFileSync(full, 'utf8'))?.[1];
          if (id) ids.add(id);
        }
      }
    };
    walk(toolsDir);
    const named = TEXTS.flatMap(({ where, text }) =>
      [...text.matchAll(/`([a-z_]+)` tool/g)].map(([, id]) => ({ where, id: id! }))
    );
    expect(named.length).toBeGreaterThan(3);
    for (const { where, id } of named) {
      if (!ids.has(id)) throw new Error(`${where}: names a tool "${id}" that does not exist`);
    }
  });

  it('links only repository files that exist', () => {
    const repo = join(__dirname, '../../../../../..');
    const prefix = 'https://github.com/snaglet-org/snaglet/blob/main/';
    for (const link of WEB_LINKS) {
      if (link.startsWith(prefix))
        expect(existsSync(join(repo, link.slice(prefix.length)))).toBe(true);
    }
  });

  it('lands every in-doc heading link on a heading of its own doc', () => {
    for (const doc of ALL_DOCS) {
      for (const [label, href] of inDocLinks(doc.body)) {
        const ref = parseInDocHeadingHref(href);
        const found = ref ? resolveDocAnchor(doc.body, { heading: ref }) : null;
        // A note means the heading is gone or changed level: either way, stale.
        if (!found?.lines || found.note) {
          throw new Error(`${doc.slug}: link "${label}" points at ${href}, no heading of this doc`);
        }
      }
    }
  });

  it('keeps in-doc heading links as written when the seed resolves its links', () => {
    for (const doc of ALL_DOCS) {
      expect(inDocLinks(resolveSeedLinks(doc.body, NO_SEED_IDS))).toEqual(inDocLinks(doc.body));
    }
  });

  it('opens the worksheet with an index that links every section, in order', () => {
    const worksheet = ONBOARDING_DOCS.find((doc) => doc.slug === 'getting-started-worksheet');
    const body = worksheet?.body ?? '';
    const sections = docHeadings(body).filter((heading) => heading.level === 2);
    expect(sections.length).toBeGreaterThanOrEqual(9);
    // One list item per section: a chip to that heading of this doc, labeled
    // with the heading, above the first section.
    const self = 'onboarding:getting-started-worksheet';
    const items = body
      .split('\n')
      .filter((line) => line.startsWith(`- [`) && line.includes(`](${self}#h=`));
    expect(items).toEqual(
      sections.map((heading) => `- [${heading.text}](${self}#h=${heading.slug})`)
    );
    expect(body.indexOf(items[items.length - 1]!)).toBeLessThan(body.indexOf('\n## '));
  });

  it('carries no personal data, banned names or other products', () => {
    const worksheet = ONBOARDING_DOCS.find((doc) => doc.slug === 'getting-started-worksheet');
    expect(worksheet?.body.split(TOOL_EXAMPLES)).toHaveLength(2);
    for (const { where, text } of TEXTS) {
      for (const pattern of PERSONAL) {
        const hit = text.match(pattern);
        if (hit) throw new Error(`${where}: personal-looking text "${hit[0]}"`);
      }
      const named = where === 'getting-started-worksheet' ? text.replace(TOOL_EXAMPLES, '') : text;
      const banned = named.match(BANNED);
      if (banned) throw new Error(`${where}: banned name "${banned[0]}"`);
      if (where !== 'providers-and-credentials') {
        const provider = text.match(PROVIDER_NAMES);
        if (provider) throw new Error(`${where}: provider name "${provider[0]}"`);
      }
    }
  });

  it('sends people only to Settings rows a new install shows', () => {
    // Profile and Agents give way to Home (the hub_home flag ships on);
    // Command line waits for the cli_pane_ui flag, which ships off.
    const hidden = new Set<string>([
      SETTINGS_ENTRY_LABELS.profile,
      SETTINGS_ENTRY_LABELS['agent-instructions'],
      SETTINGS_ENTRY_LABELS.cli,
    ]);
    const shown = Object.values(SETTINGS_ENTRY_LABELS).filter((label) => !hidden.has(label));
    const docsDir = join(__dirname, '../../../../../../docs');
    const pages = readdirSync(docsDir)
      .filter((file) => file.endsWith('.md'))
      .map((file) => ({ where: `docs/${file}`, text: readFileSync(join(docsDir, file), 'utf8') }));
    const named = [...TEXTS, ...pages].flatMap(({ where, text }) =>
      // "System Settings → …" is the Mac's own app.
      [...text.matchAll(/(?<!System )Settings → ([^\n]*)/g)].map((match) => ({
        where,
        rest: match[1]!,
      }))
    );
    expect(named.length).toBeGreaterThan(5);
    for (const { where, rest } of named) {
      const row = shown.find((label) => new RegExp(`^${label}(?!\\w)`).test(rest));
      if (!row)
        throw new Error(`${where}: "Settings → ${rest.slice(0, 40)}" names no Settings row`);
    }
  });

  it('does not promise the Home pane, which ships behind a flag', () => {
    for (const { where, text } of TEXTS) {
      if (/Cmd\+Shift\+H/.test(text)) throw new Error(`${where} mentions Cmd+Shift+H`);
    }
  });
});

describe('starter agents', () => {
  it('are Patty and Clio, with no provider or model of their own', () => {
    expect(STARTER_AGENTS.map((agent) => agent.name)).toEqual(['Patty', 'Clio']);
    for (const agent of STARTER_AGENTS) {
      expect(agent).not.toHaveProperty('provider');
      expect(agent).not.toHaveProperty('modelId');
    }
  });

  it('link their Context Index doc from the prompt, and Patty keeps onboarding in her index', () => {
    for (const agent of STARTER_AGENTS) {
      expect(agent.systemPrompt).toContain(
        `**Context Index:** [${agent.name}: Context Index](onboarding:${agent.id}-context-index)`
      );
      expect(agent.systemPrompt).toMatch(/Update it as you learn/);
      // Its Self-improvement section names a heading the index has.
      expect(agent.systemPrompt).toContain(
        `](onboarding:${agent.id}-context-index#h=self-improvement)`
      );
    }
    const patty = STARTER_AGENTS.find((agent) => agent.id === 'patty')!;
    // Onboarding lives in her Context Index, which the prompt tells her to read first.
    expect(patty.systemPrompt).not.toContain('Onboarding Guide');
    expect(patty.systemPrompt).toContain('Read it when you start work in a thread');
    const index = AGENT_INSTRUCTION_DOCS.find((doc) => doc.slug === 'patty-context-index')!;
    expect(index.body).toContain(
      'read [Patty: Onboarding Guide](onboarding:patty-onboarding-guide) first and follow its steps'
    );
  });

  it("keep each agent's docs in its own folder inside Agents", () => {
    expect(AGENT_INSTRUCTION_DOCS.map((doc) => doc.slug)).toEqual([
      'patty-agent-design',
      'patty-context-index',
      'patty-onboarding-guide',
      'clio-agent-design',
      'clio-context-index',
    ]);
    for (const doc of AGENT_INSTRUCTION_DOCS) {
      expect(doc.folder).toBe(agentFolder(doc.slug.split('-')[0] as 'patty' | 'clio'));
      expect(doc.title.startsWith(`${doc.title.split(':')[0]}: `)).toBe(true);
    }
    for (const agent of STARTER_AGENTS) {
      expect(designDoc(agent.id).title).toBe(agentDesignTitle(agent.name));
      expect(indexDoc(agent.id).title).toBe(`${agent.name}: Context Index`);
    }
  });

  it('keep the identity and the whole system prompt in sections of the design doc', () => {
    expect(SYSTEM_PROMPT_SECTION).toBe('instructions');
    for (const agent of STARTER_AGENTS) {
      const { body } = designDoc(agent.id);
      expect(body).toContain(`**Role:** ${agent.role}`);
      expect(body.match(/^## .+$/gm)).toEqual(['## Identity', `## ${SYSTEM_PROMPT_HEADING}`]);
      expect(body).toContain(
        `[${agent.name}: Context Index](onboarding:${agent.id}-context-index)`
      );
      // What the agent's fields transclude is exactly the agent's own text.
      expect(section(body, IDENTITY_SECTION)).toBe(`## Identity\n\n${agent.identity}`);
      expect(section(body, SYSTEM_PROMPT_SECTION)).toBe(
        `## ${SYSTEM_PROMPT_HEADING}\n\n${agent.systemPrompt}`
      );
      // A user reading the doc learns where it shows and how to change it.
      expect(body).toContain(`Agents → ${agent.name} → Behavior`);
    }
  });

  it('give both context indexes the same core sections', () => {
    for (const agent of STARTER_AGENTS) {
      const { body } = indexDoc(agent.id);
      const own = body.match(/^## .+$/gm) ?? [];
      expect(own[0]).toBe('## Key docs');
      for (const shared of ['## Updated instructions', '## Self-improvement']) {
        expect(own).toContain(shared);
      }
      expect(body).toContain(
        'reads this when she starts work and updates it as she learns. The user can read and edit it too.'
      );
      expect(body).toContain(
        `[${agentDesignTitle(agent.name)}](onboarding:${agent.id}-agent-design)`
      );
    }
  });

  it('default to their own text, links as plain words, until the seed links the design doc', () => {
    for (const agent of STARTER_AGENTS) {
      expect(starterAgentDefaults(agent)).toEqual({
        identity: agent.identity,
        systemPrompt: resolveSeedLinks(agent.systemPrompt, NO_SEED_IDS),
      });
    }
  });

  it('keep the identity to persona and tone: no tables, tools or duties', () => {
    for (const agent of STARTER_AGENTS) {
      expect(agent.identity).not.toMatch(/\]\(|table|tool|automation|calendar|search/i);
    }
  });

  it('read as plain text before the seed has linked anything', () => {
    for (const agent of STARTER_AGENTS) {
      const plain = resolveSeedLinks(agent.systemPrompt, NO_SEED_IDS);
      expect(plain).not.toMatch(/\]\(onboarding/);
      expect(plain).toContain(`**Context Index:** ${agent.name}: Context Index`);
    }
  });
});

describe('agent-facing text speaks to the agent', () => {
  /**
   * Text the agent itself reads: its prompt, its persona, the design doc
   * sections its fields transclude, and the sections of its other docs. Each
   * doc's opening note is for the user and names the agent.
   */
  const AGENT_FACING = STARTER_AGENTS.flatMap((agent) => [
    { agent: agent.name, where: `${agent.id} prompt`, text: agent.systemPrompt },
    { agent: agent.name, where: `${agent.id} identity`, text: agent.identity },
    ...[IDENTITY_SECTION, SYSTEM_PROMPT_SECTION].map((slug) => ({
      agent: agent.name,
      where: `${agent.id}-agent-design#h=${slug}`,
      text: section(designDoc(agent.id).body, slug) ?? '',
    })),
    ...AGENT_INSTRUCTION_DOCS.filter(
      (doc) => doc.slug.startsWith(`${agent.id}-`) && !doc.slug.endsWith('-agent-design')
    ).map((doc) => ({ agent: agent.name, where: doc.slug, text: sections(doc.body) })),
  ]);

  /** The text without its title line, link labels, the "You are <Name>" opening and @<Name> mention handles. */
  const spoken = (text: string, name: string) =>
    text
      .replace(/^# .*$/m, '')
      .replace(SEED_LINK, '')
      .replace(new RegExp(`You are ${name}\\b`, 'g'), '')
      .replace(new RegExp(`@${name}\\b`, 'g'), '');

  it('has a Context Index doc for every starter agent, and an Onboarding Guide for Patty', () => {
    expect(AGENT_FACING.map(({ where }) => where)).toEqual(
      expect.arrayContaining([
        'patty-context-index',
        'patty-onboarding-guide',
        'clio-context-index',
      ])
    );
  });

  it.each(AGENT_FACING)('$where says "you", not its own name', ({ agent, text }) => {
    expect(spoken(text, agent)).not.toMatch(new RegExp(`\\b${agent}\\b`));
  });
});
