/**
 * The starter content a fresh install gets, created once: the Onboarding
 * folder of guide docs, a sample project, the starter agents' own docs in an
 * Agents folder (a folder per agent), the starter tables, and an empty
 * workspace thread for each starter agent.
 *
 * It runs only while the `onboarding.seed` setting says `pending`, which the
 * database bootstrap writes when it creates a brand-new schema. The status
 * moves to `running` before the first write and ends `done`, `skipped` or
 * `failed`; none of those runs again, so content the user deletes never comes
 * back and a crash midway never seeds twice.
 *
 * Everything goes through the same models and realtime events as the routes
 * and tools, so an open window shows it at once and links and backlinks are
 * recorded. It sends no messages, starts no agent run, calls no model and
 * embeds nothing: the embedding worker indexes the docs later, like any doc,
 * when search by meaning is on.
 */
import { getDb } from '@snaglet/db';
import { transaction } from '@snaglet/db/db';
import { Containers } from '@snaglet/db/tables/containers';
import { Docs } from '@snaglet/db/tables/docs';
import { Threads } from '@snaglet/db/tables/threads';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { generateId, getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import {
  emitTreeNodeCreated,
  snapshotFromContainer,
  snapshotFromDoc,
  snapshotFromThread,
} from '@server/realtime/surfaces/tree';
import { emitThreadCreated, snapshotFromThreadNode } from '@server/realtime/surfaces/threads';
import { agentService } from '@server/services/AgentService';
import { syncContentRefLinks } from '@server/services/contentRefs';
import { settingsService } from '@server/services/settings/settingsService';
import {
  onboardingSettings,
  type OnboardingSeedRecord,
} from '@server/services/settings/categories/onboarding';
import { ONBOARDING_DOCS, ONBOARDING_FOLDERS, SAMPLE_PROJECT_DOCS } from './content';
import {
  AGENT_INSTRUCTION_DOCS,
  IDENTITY_SECTION,
  SYSTEM_PROMPT_HEADING,
  SYSTEM_PROMPT_SECTION,
  agentDesignTitle,
  agentFolder,
} from './content/agentInstructions';
import type { OnboardingDocSource, OnboardingFolder } from './content/types';
import { resolveSeedLinks, type SeedIds } from './seedLinks';
import { STARTER_AGENTS, starterAgentDefaults } from './starterAgents';
import { seedSampleProjectTable, seedStarterTables } from './starterTables';

const ONBOARDING_FOLDER_NAME = 'Onboarding';
const SAMPLE_PROJECT_NAME = 'My First Project (Sample)';
const SAMPLE_PROJECT_DESCRIPTION =
  'A sample project that shows how Snaglet holds one body of work: docs, a task table and ' +
  'threads in one place. Edit it, copy the pattern, or delete it.';
const AGENTS_FOLDER_NAME = 'Agents';

/**
 * Each starter agent's thread and what it is for. Both are workspace-wide (no
 * project), so the agents search, remember and create across the whole
 * workspace from them. A new thread opens at the top of its list, so the last
 * one here is listed first.
 */
const STARTER_THREADS = [
  {
    agentId: 'clio',
    title: 'Plan my week',
    instructions:
      "This is the user's planning thread with Clio: tasks, events, reminders, the calendar and " +
      'weekly plans.',
  },
  {
    agentId: 'patty',
    title: 'Onboarding',
    instructions:
      "This is the user's onboarding thread. When they are new or ask for help getting started, " +
      'follow the Onboarding section of your instructions.',
  },
] as const;

let inFlight: Promise<OnboardingSeedRecord | null> | null = null;

/**
 * Seed the starter content if this database is a new install that has not
 * been seeded yet. Never throws; returns the final record, or null when
 * there was nothing to do.
 */
export function seedOnboardingOnce(): Promise<OnboardingSeedRecord | null> {
  inFlight ??= run().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function run(): Promise<OnboardingSeedRecord | null> {
  let record: OnboardingSeedRecord | null;
  try {
    record = await settingsService.readOptional(onboardingSettings.seed);
  } catch (err) {
    logger.warn(`[onboarding] could not read the seed status: ${getErrorMessage(err)}`);
    return null;
  }
  if (record?.status !== 'pending') return null;

  try {
    if (await workspaceHasContent()) {
      return await finish({ status: 'skipped', at: new Date().toISOString() });
    }
    await settingsService.write(onboardingSettings.seed, {
      status: 'running',
      at: new Date().toISOString(),
    });
    const created = await seed();
    logger.info(
      `[onboarding] seeded the starter content: ${Object.keys(created.docs).length} docs, ` +
        `${Object.keys(created.tables).length} tables, ${Object.keys(created.threads).length} threads`
    );
    return await finish({ status: 'done', at: new Date().toISOString(), ...created });
  } catch (err) {
    logger.warn(`[onboarding] seeding the starter content failed: ${getErrorMessage(err)}`);
    return finish({
      status: 'failed',
      at: new Date().toISOString(),
      error: getErrorMessage(err),
    }).catch((writeErr: unknown) => {
      logger.warn(`[onboarding] could not record the failure: ${getErrorMessage(writeErr)}`);
      return null;
    });
  }
}

async function finish(record: OnboardingSeedRecord): Promise<OnboardingSeedRecord> {
  await settingsService.write(onboardingSettings.seed, record);
  return record;
}

/**
 * A database restored or carried over into a pending state must not get the
 * starter content on top of its own: any doc, workspace thread or folder
 * means it is not a new install.
 */
async function workspaceHasContent(): Promise<boolean> {
  const { rows } = await getDb().query<{ has: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM public.docs)
         OR EXISTS (SELECT 1 FROM public.containers)
         OR EXISTS (SELECT 1 FROM public.threads WHERE kind = 'chat' AND parent_thread_id IS NULL)
         AS has`
  );
  return rows[0]?.has === true;
}

async function createContainer(input: {
  name: string;
  parentId: string | null;
  project: boolean;
  sortOrder: number;
}): Promise<string> {
  const container = await Containers.create({
    name: input.name,
    parentId: input.parentId,
    category: input.project ? 'project' : null,
    sortOrder: input.sortOrder,
  });
  emitTreeNodeCreated(snapshotFromContainer(container));
  return container.id;
}

async function createFolders(): Promise<Record<string, string>> {
  const folders: Record<string, string> = {};
  // The guides live in a plain folder; only the sample project is a project.
  folders.onboarding = await createContainer({
    name: ONBOARDING_FOLDER_NAME,
    parentId: null,
    project: false,
    sortOrder: 0,
  });
  // Folders count their places per parent, as docs do per folder.
  const position = new Map<string, number>();
  for (const folder of ONBOARDING_FOLDERS) {
    const parent = folder.parent ?? 'onboarding';
    const parentId = folders[parent];
    if (!parentId) throw new Error(`No folder ${parent} for ${folder.key}`);
    const sortOrder = position.get(parent) ?? 0;
    position.set(parent, sortOrder + 1);
    folders[folder.key] = await createContainer({
      name: folder.name,
      parentId,
      project: false,
      sortOrder,
    });
  }
  folders['sample-project'] = await createContainer({
    name: SAMPLE_PROJECT_NAME,
    parentId: null,
    project: true,
    sortOrder: 1,
  });
  await Containers.update(folders['sample-project'], { description: SAMPLE_PROJECT_DESCRIPTION });
  folders.agents = await createContainer({
    name: AGENTS_FOLDER_NAME,
    parentId: null,
    project: false,
    sortOrder: 2,
  });
  for (const [index, starter] of STARTER_AGENTS.entries()) {
    folders[agentFolder(starter.id)] = await createContainer({
      name: starter.name,
      parentId: folders.agents,
      project: false,
      sortOrder: index,
    });
  }
  return folders;
}

async function createThreads(): Promise<Record<string, string>> {
  const threads: Record<string, string> = {};
  for (const starter of STARTER_THREADS) {
    const id = generateId('thread');
    const thread = await transaction(async (tx) => {
      const created = await Threads.create(
        {
          id,
          title: starter.title,
          projectId: null,
          threadSystemPrompt: starter.instructions,
        },
        tx
      );
      await ThreadParticipants.addParticipant({ threadId: id, agentId: starter.agentId }, tx);
      return created;
    });
    emitTreeNodeCreated(snapshotFromThread(thread));
    emitThreadCreated(snapshotFromThreadNode(thread));
    threads[starter.agentId] = id;
  }
  return threads;
}

const ALL_DOCS: readonly OnboardingDocSource[] = [
  ...ONBOARDING_DOCS,
  ...SAMPLE_PROJECT_DOCS,
  ...AGENT_INSTRUCTION_DOCS,
];

async function createDocs(ids: SeedIds): Promise<void> {
  const position = new Map<OnboardingFolder, number>();
  const created: Array<{ id: string; content: string | null }> = [];
  for (const source of ALL_DOCS) {
    const containerId = ids.folders[source.folder];
    if (!containerId) throw new Error(`No folder for ${source.slug} (${source.folder})`);
    const sortOrder = position.get(source.folder) ?? 0;
    position.set(source.folder, sortOrder + 1);
    const doc = await Docs.create({
      id: ids.docs[source.slug],
      title: source.title,
      containerId,
      content: resolveSeedLinks(source.body, ids),
      sortOrder,
    });
    emitTreeNodeCreated(snapshotFromDoc(doc));
    created.push({ id: doc.id, content: doc.content ?? null });
  }
  // Links and backlinks once every doc exists: a guide links docs that come after it.
  for (const doc of created) syncContentRefLinks(doc.id, doc.content);
}

/**
 * Point each starter agent's Identity and System prompt at the Identity and
 * Instructions sections of its design doc, so editing the doc changes the
 * agent. Only an agent still exactly as it was created is linked: one the
 * user already changed, or one that does not exist, is left alone.
 */
async function linkStarterAgents(ids: SeedIds): Promise<void> {
  for (const starter of STARTER_AGENTS) {
    const designDocId = ids.docs[`${starter.id}-agent-design`];
    // Every starter agent has a design doc (content/agentInstructions).
    if (!designDocId) continue;
    const agent = await agentService.get(starter.id);
    if (!agent) continue;
    const defaults = starterAgentDefaults(starter);
    const untouched =
      (agent.rawSystemPrompt ?? '') === defaults.systemPrompt &&
      (agent.rawIdentity ?? '') === defaults.identity;
    if (!untouched) continue;
    const title = agentDesignTitle(starter.name);
    await agentService.update(starter.id, {
      identity: `![${title}](${designDocId}#h=${IDENTITY_SECTION})`,
      rawSystemPrompt: `![${title} › ${SYSTEM_PROMPT_HEADING}](${designDocId}#h=${SYSTEM_PROMPT_SECTION})`,
    });
  }
}

interface SeededIds {
  folders: Record<string, string>;
  docs: Record<string, string>;
  tables: Record<string, string>;
  threads: Record<string, string>;
}

async function seed(): Promise<SeededIds> {
  // Reading the roster creates the starter agents on an empty database.
  await agentService.list();
  const folders = await createFolders();
  const tables: Record<string, string> = { ...(await seedStarterTables()) };
  tables['sample-tasks'] = await seedSampleProjectTable(folders['sample-project']);
  const threads = await createThreads();
  const docs = Object.fromEntries(ALL_DOCS.map((source) => [source.slug, generateId('doc')]));
  const ids: SeedIds = { docs, folders, tables, threads };
  await createDocs(ids);
  await linkStarterAgents(ids);
  return { folders, docs, tables, threads };
}
