/**
 * The one-time starter content of a new install, against real PostgreSQL:
 * what the seed creates (projects, folders, docs with resolved links and
 * backlinks, starter tables, an empty thread per starter agent, each agent's
 * Identity and System prompt transcluded from its design doc and rendered into
 * its system prompt), that it sends nothing and runs
 * nothing, and that it never runs twice, never after the content is deleted,
 * and never on a database that was not brand new.
 */
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { getDbClient } from '@snaglet/db';
import { Containers } from '@snaglet/db/tables/containers';
import { Docs } from '@snaglet/db/tables/docs';
import { Settings } from '@snaglet/db/tables/settings';
import { Projects } from '@snaglet/db/tables/projects';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';
import { Threads } from '@snaglet/db/tables/threads';
import { TABLES_READER_ROLE } from '@snaglet/db/runtime/postgres/runtime';
import { GHOST_AGENT_ID } from '@snaglet/shared/constants';
import { parseInDocHeadingHref, resolveDocAnchor } from '@snaglet/shared/utils';
import { loadTestClusterHandoff } from '../../../../../support/pgTestCluster';

const handoff = loadTestClusterHandoff();
const database = process.env.SNAGLET_PG_TEST_DATABASE;
if (!database) throw new Error('Missing SNAGLET_PG_TEST_DATABASE');
{
  const url = new URL('postgresql://localhost');
  url.username = TABLES_READER_ROLE;
  url.password = createHash('sha256')
    .update(`${TABLES_READER_ROLE}:${handoff.runToken}`)
    .digest('base64url');
  url.pathname = `/${database}`;
  url.searchParams.set('host', handoff.host);
  url.port = String(handoff.port);
  url.searchParams.set('sslmode', 'disable');
  process.env.SNAGLET_TABLES_READER_URL = url.toString();
}

jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    broadcastToChannel: jest.fn(),
    broadcast: jest.fn(),
    sendToClient: jest.fn(),
  },
}));

import { agentService } from '@server/services/AgentService';
import { resolveThreadRuntimeConfig } from '@server/services/ConfigResolverService';
import { composeSystemPrompt } from '@server/services/SystemPromptComposer';
import { PERSONA_LEAD } from '@server/services/SystemPromptComposer/blocks/identityBlock';
import { listTableEntries } from '@server/domains/tables/tableEntries';
import {
  ONBOARDING_DOCS,
  ONBOARDING_FOLDERS,
  SAMPLE_PROJECT_DOCS,
} from '@server/services/onboarding/content';
import { AGENT_INSTRUCTION_DOCS } from '@server/services/onboarding/content/agentInstructions';
import { seedOnboardingOnce } from '@server/services/onboarding/seedOnboarding';
import { loadThreadCoordinates } from '@server/services/ToolService/lib/threadCoordinates';
import { findProjectAncestorChain } from '@server/services/ToolService/lib/findProjectAncestor';
import { resolveMemoryRecallProjectScope } from '@server/services/summary/memoryRecallScope';
import searchTool from '@server/services/ToolService/tools/workspace/search/tool';
import type { OnboardingSeedRecord } from '@server/services/settings/categories/onboarding';

const ALL_DOCS = [...ONBOARDING_DOCS, ...SAMPLE_PROJECT_DOCS, ...AGENT_INSTRUCTION_DOCS];
const DOC_LINK = /\]\((doc-[^)#\s]+)(?:#[^)\s]*)?\)/g;
/** The one doc another doc transcludes whole: it reads in place, with no H1. */
const TRANSCLUDED = 'transclusion-example';

let record: OnboardingSeedRecord;

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const db = await getDbClient();
  const { rows } = await db.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

async function workspaceCounts() {
  return {
    docs: await count('SELECT count(*) AS n FROM public.docs'),
    containers: await count('SELECT count(*) AS n FROM public.containers'),
    threads: await count("SELECT count(*) AS n FROM public.threads WHERE kind = 'chat'"),
    tables: await count("SELECT count(*) AS n FROM public.table_catalog WHERE origin = 'custom'"),
    agents: await count('SELECT count(*) AS n FROM public.agents'),
  };
}

function id(map: Record<string, string> | undefined, key: string): string {
  const found = map?.[key];
  if (!found) throw new Error(`seed record has no ${key}`);
  return found;
}

beforeAll(async () => {
  const seeded = await seedOnboardingOnce();
  if (!seeded) throw new Error('a fresh database should be seeded');
  record = seeded;
}, 120_000);

describe('seedOnboardingOnce on a new install', () => {
  it('finishes and records what it made', async () => {
    expect(record.status).toBe('done');
    expect(Object.keys(record.docs ?? {}).sort()).toEqual(ALL_DOCS.map((d) => d.slug).sort());
    expect(Object.keys(record.tables ?? {}).sort()).toEqual(
      ['events', 'ideas', 'reminders', 'sample-tasks', 'tasks'].sort()
    );
    expect(Object.keys(record.threads ?? {}).sort()).toEqual(['clio', 'patty']);
    const stored = await Settings.read('onboarding', 'seed');
    expect((stored?.value as OnboardingSeedRecord).status).toBe('done');
  });

  it('makes the Onboarding folder (not a project) with its folders in order, the sample project and the Agents folder', async () => {
    const onboarding = await Containers.findById(id(record.folders, 'onboarding'));
    expect(onboarding).toMatchObject({ name: 'Onboarding', parentId: null });
    expect(onboarding?.category).toBeNull();
    expect(await Projects.findById(id(record.folders, 'onboarding'))).toBeNull();

    expect(Object.keys(record.folders ?? {}).sort()).toEqual(
      [
        'agent-clio',
        'agent-patty',
        'agents',
        'etc',
        'features',
        'onboarding',
        'reference',
        'responsible-ai',
        'sample-project',
        'start',
      ].sort()
    );
    // Start here, Features, Reference and etc; Using AI Responsibly sits inside Reference.
    const top = await Containers.listByParent(onboarding!.id);
    expect(top.map((folder) => folder.name)).toEqual([
      'Start here',
      'Features',
      'Reference',
      'etc',
    ]);
    const folders = await Promise.all(
      ONBOARDING_FOLDERS.map((folder) => Containers.findById(id(record.folders, folder.key)))
    );
    expect(folders.map((folder) => folder?.name)).toEqual(ONBOARDING_FOLDERS.map((f) => f.name));
    for (const [index, folder] of ONBOARDING_FOLDERS.entries()) {
      expect(folders[index]?.parentId).toBe(id(record.folders, folder.parent ?? 'onboarding'));
    }
    const orders = top.map((folder) => folder.sortOrder);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    expect(
      (await Containers.listByParent(id(record.folders, 'reference'))).map((folder) => folder.name)
    ).toEqual(['Using AI Responsibly']);

    const sample = await Containers.findById(id(record.folders, 'sample-project'));
    expect(sample).toMatchObject({ name: 'My First Project (Sample)', category: 'project' });
    expect(sample?.description).toMatch(/sample/i);
    expect(await Projects.findById(id(record.folders, 'sample-project'))).not.toBeNull();
    // The sample project's task table belongs to it.
    expect((await TableCatalog.findById(id(record.tables, 'sample-tasks')))?.projectId).toBe(
      id(record.folders, 'sample-project')
    );

    const agents = await Containers.findById(id(record.folders, 'agents'));
    expect(agents).toMatchObject({ name: 'Agents', parentId: null });
    expect(agents?.category).toBeNull();
    // A folder per starter agent inside it.
    const perAgent = await Containers.listByParent(agents!.id);
    expect(perAgent.map((folder) => [folder.id, folder.name])).toEqual([
      [id(record.folders, 'agent-patty'), 'Patty'],
      [id(record.folders, 'agent-clio'), 'Clio'],
    ]);
  });

  it('writes every doc in its folder with an H1 title and links that resolve', async () => {
    const docIds = new Set(Object.values(record.docs ?? {}));
    for (const source of ALL_DOCS) {
      const doc = await Docs.findById(id(record.docs, source.slug));
      expect(doc?.title).toBe(source.title);
      expect(doc?.containerId).toBe(id(record.folders, source.folder));
      const content = doc?.content ?? '';
      if (source.slug === TRANSCLUDED) expect(content).toBe(source.body);
      else expect(content.split('\n')[0]).toBe(`# ${source.title}`);
      // Every placeholder was resolved; none is left for the reader.
      expect(content).not.toMatch(/\]\(onboarding/);
      for (const [, target] of content.matchAll(DOC_LINK)) expect(docIds.has(target!)).toBe(true);
    }
    // Docs and the editor shows the example doc in place.
    expect((await Docs.findById(id(record.docs, 'docs-and-the-editor')))?.content).toContain(
      `\n![](${id(record.docs, TRANSCLUDED)})\n`
    );
  });

  it("keeps each doc's links to its own headings as written, each landing on a heading", async () => {
    const inDocLinks = (text: string) => text.match(/\]\(#[^)\s]+\)/g) ?? [];
    // The worksheet's index chips its own headings, each one landing.
    const worksheetId = id(record.docs, 'getting-started-worksheet');
    const worksheet = (await Docs.findById(worksheetId))?.content ?? '';
    const chips = [
      ...worksheet.matchAll(new RegExp(`\\]\\(${worksheetId}(#h=[a-z0-9-]+)\\)`, 'g')),
    ];
    expect(chips.length).toBeGreaterThanOrEqual(9);
    for (const [, fragment] of chips) {
      const ref = parseInDocHeadingHref(fragment!);
      expect(ref && resolveDocAnchor(worksheet, { heading: ref }).lines).not.toBeNull();
    }
    for (const source of ALL_DOCS) {
      const content = (await Docs.findById(id(record.docs, source.slug)))?.content ?? '';
      expect(inDocLinks(content)).toEqual(inDocLinks(source.body));
      for (const link of inDocLinks(content)) {
        const ref = parseInDocHeadingHref(link.slice(2, -1));
        expect(ref && resolveDocAnchor(content, { heading: ref }).lines).not.toBeNull();
      }
    }
  });

  it('lists each Onboarding folder in source order, the Features index first, linking every guide', async () => {
    for (const folder of ONBOARDING_FOLDERS) {
      const listed = await Docs.listByContainer(id(record.folders, folder.key));
      expect(listed.map((doc) => doc.title)).toEqual(
        ONBOARDING_DOCS.filter((doc) => doc.folder === folder.key).map((doc) => doc.title)
      );
    }

    const features = await Docs.listByContainer(id(record.folders, 'features'));
    expect(features).toHaveLength(21);
    expect(features[0]).toMatchObject({ id: id(record.docs, 'features-index'), title: 'Features' });
    // The transcluded example comes last and is not a guide.
    expect(features[features.length - 1]?.id).toBe(id(record.docs, TRANSCLUDED));
    const index = features[0]!.content ?? '';
    for (const guide of features.slice(1, -1)) expect(index).toContain(`](${guide.id})`);
    expect(index).not.toContain(`](${id(record.docs, TRANSCLUDED)})`);
  });

  it('records backlinks between the docs', async () => {
    const welcome = id(record.docs, 'welcome-to-snaglet');
    const worksheet = id(record.docs, 'getting-started-worksheet');
    // Link writes are fire-and-forget; give them a moment to land.
    let links = 0;
    for (let attempt = 0; attempt < 50 && links === 0; attempt += 1) {
      links = await count(
        `SELECT count(*) AS n FROM public.links
          WHERE source_id = $1 AND target_id = $2 AND relation = 'references'`,
        [welcome, worksheet]
      );
      if (links === 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(links).toBe(1);
  });

  it('starts each agent in its own empty thread, with no runs or messages anywhere', async () => {
    const db = await getDbClient();
    const patty = id(record.threads, 'patty');
    const clio = id(record.threads, 'clio');
    // Both are workspace-wide: no project, listed together in the top-level Threads group.
    expect(await Threads.findById(patty)).toMatchObject({
      title: 'Onboarding',
      projectId: null,
      dispatchMode: 'mentioned',
    });
    expect(await Threads.findById(clio)).toMatchObject({
      title: 'Plan my week',
      projectId: null,
      dispatchMode: 'mentioned',
    });

    const { rows: participants } = await db.query<{ thread_id: string; agent_id: string }>(
      `SELECT tp.thread_id, m.agent_id FROM public.thread_participants tp
         JOIN public.members m ON m.id = tp.member_id
        WHERE tp.thread_id = ANY($1)`,
      [[patty, clio]]
    );
    expect(participants.filter((p) => p.thread_id === patty).map((p) => p.agent_id)).toEqual([
      'patty',
    ]);
    expect(participants.filter((p) => p.thread_id === clio).map((p) => p.agent_id)).toEqual([
      'clio',
    ]);

    expect(await count('SELECT count(*) AS n FROM public.messages')).toBe(0);
    expect(await count('SELECT count(*) AS n FROM public.runs')).toBe(0);
  });

  it('seeds only Patty and Clio, neither on a model', async () => {
    const agents = await agentService.list({ includeArchived: true });
    expect(
      agents
        .map((agent) => agent.id)
        .filter((agentId) => agentId !== GHOST_AGENT_ID)
        .sort()
    ).toEqual(['clio', 'patty']);
    for (const agent of agents.filter((a) => a.id !== GHOST_AGENT_ID)) {
      expect(agent.provider).toBe('');
      expect(agent.modelId).toBeNull();
    }
  });

  it("points each agent's Identity and System prompt at the sections of its design doc", async () => {
    // Each agent's folder: its design doc and Context Index, and Patty's Onboarding Guide.
    for (const [agentId, slugs] of [
      ['patty', ['patty-agent-design', 'patty-context-index', 'patty-onboarding-guide']],
      ['clio', ['clio-agent-design', 'clio-context-index']],
    ] as const) {
      const listed = await Docs.listByContainer(id(record.folders, `agent-${agentId}`));
      expect(listed.map((doc) => doc.id)).toEqual(slugs.map((slug) => id(record.docs, slug)));
    }

    for (const [agentId, name] of [
      ['patty', 'Patty'],
      ['clio', 'Clio'],
    ] as const) {
      const agent = await agentService.get(agentId);
      const designId = id(record.docs, `${agentId}-agent-design`);
      const indexId = id(record.docs, `${agentId}-context-index`);
      // Both fields are transclusions of the same design doc, nothing more.
      expect(agent?.rawIdentity).toBe(`![${name}: Agent Design](${designId}#h=identity)`);
      expect(agent?.rawSystemPrompt).toBe(
        `![${name}: Agent Design › Instructions](${designId}#h=instructions)`
      );
      // Resolved, each is its section of the doc, and only that section.
      expect(agent?.identity).toContain(`part="h=identity">\n## Identity\n\nYou are ${name}`);
      expect(agent?.identity).not.toContain('## Instructions');
      expect(agent?.systemPrompt).toContain(
        `part="h=instructions">\n## Instructions\n\nYou are ${name}`
      );
      expect(agent?.systemPrompt).not.toContain('## Identity');
      expect(agent?.systemPrompt).not.toContain('](onboarding');
      // The prompt links the agent's Context Index doc and its Self-improvement section.
      expect(agent?.systemPrompt).toContain(
        `**Context Index:** [${name}: Context Index](${indexId})`
      );
      expect(agent?.systemPrompt).toContain(`](${indexId}#h=self-improvement)`);
      const index = (await Docs.findById(indexId))?.content ?? '';
      expect(
        resolveDocAnchor(index, { heading: { slug: 'self-improvement' } }).lines
      ).not.toBeNull();
      // Every doc link in the resolved prompt leads to a seeded doc.
      for (const [, target] of (agent?.systemPrompt ?? '').matchAll(DOC_LINK)) {
        expect(await Docs.findById(target!)).not.toBeNull();
      }
    }
  });

  it('changes the agent when its design doc is edited', async () => {
    const designId = id(record.docs, 'clio-agent-design');
    const original = (await Docs.findById(designId))?.content ?? '';
    const added = 'Always confirm the time zone before you add a reminder.';
    const noted = 'Prefers mornings for focus time.';
    const indexId = id(record.docs, 'clio-context-index');
    const originalIndex = (await Docs.findById(indexId))?.content ?? '';
    try {
      // A line at the end of the Instructions section, and a note in the Context Index.
      await Docs.update(designId, { content: `${original.trimEnd()}\n- ${added}\n` });
      await Docs.update(indexId, { content: `${originalIndex.trimEnd()}\n- ${noted}\n` });
      const clio = await agentService.get('clio');
      expect(clio?.systemPrompt).toContain(added);
      // The identity section ends before the instructions, so it is unchanged.
      expect(clio?.identity).not.toContain(added);
      // The Context Index is the agent's notebook, not part of its settings.
      expect(clio?.systemPrompt).not.toContain(noted);
    } finally {
      await Docs.update(designId, { content: original });
      await Docs.update(indexId, { content: originalIndex });
    }
    expect((await agentService.get('clio'))?.systemPrompt).not.toContain(added);
  });

  it("renders Patty's system prompt with both sections inlined, not as transclusion syntax", async () => {
    const patty = await agentService.get('patty');
    if (!patty) throw new Error('Patty is missing');
    const threadId = id(record.threads, 'patty');
    const designId = id(record.docs, 'patty-agent-design');
    const blocks = await composeSystemPrompt({
      agent: patty,
      runtimeAgent: patty,
      threadAgentOverride: undefined,
      threadId,
      threadRuntimeConfig: await resolveThreadRuntimeConfig(threadId),
      isGroup: false,
      dispatchMode: 'mentioned',
      agentTools: [],
      participantAgentIds: ['patty'],
      replyAgentId: 'patty',
      agentSoftThresholdNotified: new Set<string>(),
      agentDispatchCount: new Map<string, number>(),
      runKind: 'realtime_thread',
      runParams: {},
    });
    const text = blocks.map((block) => block.text).join('\n\n');

    expect(text).not.toContain('![Patty: Agent Design]');
    expect(text).not.toContain(`](${designId}#h=identity)`);
    expect(text).not.toContain(`](${designId}#h=instructions)`);
    // What stays a link is the pointer to her Context Index, which holds onboarding.
    expect(text).toContain(`](${id(record.docs, 'patty-context-index')})`);
    expect(text).not.toContain(`](${id(record.docs, 'patty-onboarding-guide')})`);
    // The persona block: the Identity section, framed as persona.
    expect(text).toContain(
      `${PERSONA_LEAD}\n<doc id="${designId}" path="/Agents/Patty/Patty: Agent Design" part="h=identity">\n## Identity\n\nYou are Patty, the workspace librarian.`
    );
    // How you act: the Instructions section, in full.
    expect(text).toContain(
      `## How you act\n<doc id="${designId}" path="/Agents/Patty/Patty: Agent Design" part="h=instructions">\n## Instructions\n\nYou are Patty, the librarian and onboarding guide`
    );
    for (const heading of ['### What you do', '### How you work']) {
      expect(text).toContain(heading);
    }
    expect(text).toContain('Ask before you archive, move or delete the user');
    // The persona comes before the instructions, and the thread's own note still renders.
    expect(text.indexOf('part="h=identity"')).toBeLessThan(text.indexOf('part="h=instructions"'));
    expect(text).toContain('follow the Onboarding section of your instructions');
  });

  it("works across the whole workspace from Patty's thread", async () => {
    const patty = id(record.threads, 'patty');
    // A flat thread: no project lineage, so nothing narrows to one project.
    expect((await loadThreadCoordinates(patty)).projectId).toBeNull();
    expect(await findProjectAncestorChain(patty)).toEqual([]);
    // Memories recalled there are not limited to a project family.
    expect(
      await resolveMemoryRecallProjectScope(patty, 'what did I say about planning')
    ).toBeNull();

    // Even "this project only" searches everywhere from a workspace thread:
    // her Context Index, the guides and the sample project's docs.
    const output = await searchTool(
      { query: 'Context Index', mode: 'keyword', project_scope: 'only', limit: 20 },
      {},
      { threadId: patty, agentId: 'patty' }
    );
    const text = typeof output === 'string' ? output : JSON.stringify(output);
    expect(text).toContain(id(record.docs, 'patty-context-index'));
    const sample = await searchTool(
      { query: 'Decision Log', mode: 'keyword', project_scope: 'only', limit: 20 },
      {},
      { threadId: patty, agentId: 'patty' }
    );
    expect(typeof sample === 'string' ? sample : JSON.stringify(sample)).toContain(
      id(record.docs, 'decision-log')
    );
  });

  it('makes the starter tables, ideas, tasks and events empty, with one example reminder', async () => {
    expect((await listTableEntries(id(record.tables, 'ideas'))).entries).toHaveLength(0);
    expect((await listTableEntries(id(record.tables, 'tasks'))).entries).toHaveLength(0);
    expect((await listTableEntries(id(record.tables, 'events'))).entries).toHaveLength(0);
    expect((await listTableEntries(id(record.tables, 'reminders'))).entries).toHaveLength(1);
    expect(
      (await listTableEntries(id(record.tables, 'sample-tasks'))).entries.length
    ).toBeGreaterThan(0);
  });
});

describe('seedOnboardingOnce runs once', () => {
  it('does nothing the second time', async () => {
    const before = await workspaceCounts();
    expect(await seedOnboardingOnce()).toBeNull();
    expect(await workspaceCounts()).toEqual(before);
  });

  it('never brings back content the person deleted', async () => {
    const welcome = id(record.docs, 'welcome-to-snaglet');
    await (await getDbClient()).query('DELETE FROM public.nodes WHERE id = $1', [welcome]);
    expect(await seedOnboardingOnce()).toBeNull();
    expect(await Docs.findById(welcome)).toBeNull();
  });

  it('does nothing on a database that was not created as a new install', async () => {
    await Settings.remove('onboarding', 'seed');
    const before = await workspaceCounts();
    expect(await seedOnboardingOnce()).toBeNull();
    expect(await workspaceCounts()).toEqual(before);
  });

  it('skips a pending database that already holds content', async () => {
    await Settings.write('onboarding', 'seed', { status: 'pending' });
    const before = await workspaceCounts();
    expect(await seedOnboardingOnce()).toMatchObject({ status: 'skipped' });
    expect(await workspaceCounts()).toEqual(before);
  });
});
