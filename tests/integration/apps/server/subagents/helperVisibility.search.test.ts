/**
 * Subagent helpers never surface in search, against the real database.
 *
 * The fixture puts a helper thread, its message and summary, and a helper
 * agent beside visible twins carrying the same words (helperFixture.ts). Every
 * lane must return the visible row and never the helper one: workspace_search
 * keyword, fuzzy and semantic (FTS and vector) lanes — with or without
 * include_archived — the palette's node search, palette-only lanes, browse,
 * exact-id lookup and hydration, and workspace_orient's recent list.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { closeDatabase, getDb } from '@snaglet/db';
import { Embeddings } from '@snaglet/db/tables/embeddings';
import { searchLexicalWorkspace } from '@server/services/ToolService/handlers/search/workspaceSearch/lexical';
import { searchFuzzyWorkspace } from '@server/services/ToolService/handlers/search/workspaceSearch/fuzzy';
import {
  semanticFtsCandidates,
  semanticVectorCandidates,
} from '@server/services/ToolService/handlers/search/workspaceSearch/semanticCandidates';
import type { SearchableKind } from '@server/services/ToolService/handlers/search/workspaceSearch/types';
import { ftsSearchNodes } from '@server/services/search/ftsSearchNodes';
import { hydratePaletteHits, paletteHit } from '@server/services/search/paletteSearchHydration';
import {
  browseKind,
  resolveExactId,
  searchPaletteOnlyKind,
} from '@server/services/search/paletteSearchQueries';
import { loadRecentInScope } from '@server/services/ToolService/handlers/trivial/workspaceOrient';
import {
  AGENT_ID,
  AGENT_NAME,
  HELPER_AGENT_ID,
  HELPER_MESSAGE_ID,
  HELPER_SUMMARY_ID,
  HELPER_THREAD_ID,
  MESSAGE_ID,
  PROJECT_ID,
  SUMMARY_ID,
  THREAD_ID,
  WORD,
  seedHelperWorkspace,
} from './helperFixture';

const PROVIDER_ID = 'test-provider-a';
const MODEL_KEY = 'test-embedding-model-a';
const MODEL_ID = 'model-1111111111111-aaaaaaaaa';

function topicVector(): number[] {
  const vector = new Array<number>(768).fill(0);
  vector[17] = 1;
  return vector;
}

const HELPER_IDS = [HELPER_THREAD_ID, HELPER_MESSAGE_ID, HELPER_SUMMARY_ID, HELPER_AGENT_ID];

function expectVisibleOnly(ids: string[], visible: string[]): void {
  expect(ids).toEqual(expect.arrayContaining(visible));
  for (const helperId of HELPER_IDS) expect(ids).not.toContain(helperId);
}

describe('subagent helpers stay out of search', () => {
  beforeAll(async () => {
    await seedHelperWorkspace();
    const pool = getDb();
    await pool.query(
      `INSERT INTO public.providers (id, name, type) VALUES ($1, 'Test Provider A', 'runtime')`,
      [PROVIDER_ID]
    );
    await pool.query(
      `INSERT INTO public.models (id, provider_id, model_id, display_name, type, dimensions)
       VALUES ($1, $2, $3, 'Test Embedding Model A', 'embedding', 768)`,
      [MODEL_ID, PROVIDER_ID, MODEL_KEY]
    );
    // Helper vectors can exist (stale rows, or a bug); the search lanes must
    // still never return them.
    for (const nodeId of [MESSAGE_ID, HELPER_MESSAGE_ID, SUMMARY_ID, HELPER_SUMMARY_ID]) {
      await Embeddings.create({
        nodeId,
        modelId: MODEL_ID,
        vector: topicVector(),
        contentHash: `hash-${nodeId}`,
      });
    }
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('workspace_search', () => {
    const lexical = (kinds: SearchableKind[], includeArchived: boolean) =>
      searchLexicalWorkspace({
        query: WORD,
        kinds: new Set(kinds),
        limit: 20,
        allowedContainerIds: null,
        containerRowsCache: null,
        timeRange: null,
        includeArchived,
      });

    it.each([false, true])(
      'keyword lanes return the visible thread, message and summary only (include_archived=%s)',
      async (includeArchived) => {
        const { hits } = await lexical(['thread', 'message', 'thread_summary'], includeArchived);
        expectVisibleOnly(
          hits.map((hit) => hit.id),
          [THREAD_ID, MESSAGE_ID, SUMMARY_ID]
        );
      }
    );

    it('keyword lanes honor a project scope the same way', async () => {
      const { hits } = await searchLexicalWorkspace({
        query: WORD,
        kinds: new Set<SearchableKind>(['thread', 'message', 'thread_summary']),
        limit: 20,
        allowedContainerIds: [PROJECT_ID],
        containerRowsCache: null,
        timeRange: null,
      });
      expectVisibleOnly(
        hits.map((hit) => hit.id),
        [THREAD_ID, MESSAGE_ID, SUMMARY_ID]
      );
    });

    it.each([false, true])(
      'the fuzzy title lane returns the visible thread only (include_archived=%s)',
      async (includeArchived) => {
        const { hits } = await searchFuzzyWorkspace({
          query: WORD,
          kinds: new Set<SearchableKind>(['thread']),
          limit: 20,
          allowedContainerIds: null,
          containerRowsCache: null,
          includeArchived,
        });
        expectVisibleOnly(
          hits.map((hit) => hit.id),
          [THREAD_ID]
        );
      }
    );

    it.each([false, true])(
      'the semantic FTS channel returns the visible message and summary only (include_archived=%s)',
      async (includeArchived) => {
        const rows = await semanticFtsCandidates({
          query: WORD,
          kinds: ['message', 'thread_summary'],
          limit: 20,
          allowedContainerIds: null,
          timeRange: null,
          includeArchived,
        });
        expectVisibleOnly(
          rows.map((row) => row.id),
          [MESSAGE_ID, SUMMARY_ID]
        );
      }
    );

    it.each([false, true])(
      'the vector channel never returns a helper vector (include_archived=%s)',
      async (includeArchived) => {
        const base = {
          query: WORD,
          limit: 20,
          allowedContainerIds: null,
          vector: topicVector(),
          modelId: MODEL_ID,
          timeRange: null,
          fileProjectId: null,
          filePathPrefix: null,
          includeArchived,
        };
        // Current summaries take their own query; node vectors take the other.
        const current = await semanticVectorCandidates({
          ...base,
          kinds: ['message', 'thread_summary'],
        });
        expectVisibleOnly(
          current.map((row) => row.id),
          [MESSAGE_ID, SUMMARY_ID]
        );
        const history = await semanticVectorCandidates({
          ...base,
          kinds: ['message', 'thread_summary'],
          includeSupersededThreadSummaries: true,
        });
        expectVisibleOnly(
          history.map((row) => row.id),
          [MESSAGE_ID, SUMMARY_ID]
        );
      }
    );
  });

  describe('palette', () => {
    it.each(['thread', 'message'] as const)(
      'node search for %s leaves helpers out of every scope',
      async (kind) => {
        const visible = kind === 'thread' ? THREAD_ID : MESSAGE_ID;
        for (const scope of [
          { mode: 'root' as const, source: 'explicit_container' as const },
          {
            mode: 'project' as const,
            project_id: PROJECT_ID,
            source: 'explicit_project' as const,
          },
          {
            mode: 'container_subtree' as const,
            container_id: PROJECT_ID,
            source: 'explicit_container' as const,
          },
        ]) {
          const hits = await ftsSearchNodes({ query: WORD, kind, scope, limit: 20 });
          expectVisibleOnly(
            hits.map((hit) => hit.id),
            [visible]
          );
        }
      }
    );

    it('palette-only lanes leave out helper summaries and helper agents', async () => {
      const summaries = await searchPaletteOnlyKind({
        query: WORD,
        kind: 'thread_summary',
        limit: 20,
      });
      expectVisibleOnly(
        summaries.map((hit) => hit.node_id),
        [SUMMARY_ID]
      );
      const agents = await searchPaletteOnlyKind({ query: AGENT_NAME, kind: 'agent', limit: 20 });
      expectVisibleOnly(
        agents.map((hit) => hit.node_id),
        [AGENT_ID]
      );
    });

    it('an empty-query browse never lists a helper', async () => {
      const [agents, threads, messages, summaries] = await Promise.all([
        browseKind('agent', 50),
        browseKind('thread', 50),
        browseKind('message', 50),
        browseKind('thread_summary', 50),
      ]);
      expectVisibleOnly(
        agents.map((hit) => hit.node_id),
        [AGENT_ID]
      );
      expectVisibleOnly(
        threads.map((hit) => hit.node_id),
        [THREAD_ID]
      );
      expectVisibleOnly(
        messages.map((hit) => hit.node_id),
        [MESSAGE_ID]
      );
      expectVisibleOnly(
        summaries.map((hit) => hit.node_id),
        [SUMMARY_ID]
      );
    });

    it('a pasted helper id is not an exact match; a visible one still is', async () => {
      expect(await resolveExactId(HELPER_THREAD_ID)).toBeNull();
      expect(await resolveExactId(HELPER_MESSAGE_ID)).toBeNull();
      expect(await resolveExactId(HELPER_SUMMARY_ID)).toBeNull();
      expect(await resolveExactId(THREAD_ID)).toEqual({ id: THREAD_ID, kind: 'thread' });
      expect(await resolveExactId(MESSAGE_ID)).toEqual({ id: MESSAGE_ID, kind: 'message' });
    });

    it.each([
      ['thread', THREAD_ID, HELPER_THREAD_ID],
      ['message', MESSAGE_ID, HELPER_MESSAGE_ID],
      ['thread_summary', SUMMARY_ID, HELPER_SUMMARY_ID],
      ['agent', AGENT_ID, HELPER_AGENT_ID],
    ] as const)('hydration refuses a helper %s that reaches it', async (kind, visible, helper) => {
      const hits = await hydratePaletteHits(kind, [
        paletteHit(kind, helper, {}),
        paletteHit(kind, visible, {}),
      ]);
      expect(hits.map((hit) => hit.node_id)).toEqual([visible]);
    });
  });

  it("workspace_orient's recent list leaves out the helper thread in the project", async () => {
    const rows = await loadRecentInScope(PROJECT_ID, 20);
    expectVisibleOnly(
      rows.map((row) => row.id),
      [THREAD_ID, PROJECT_ID]
    );
  });
});
