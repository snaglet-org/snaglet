import { assertSafeRealEmbeddingChildEnv } from '../safety';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { answers, documentBody, codeBody, denseBody } from './fixtures';

/** A saved report may be shared: replace machine paths and run ids with neutral placeholders. */
function neutralize(report: unknown, replacements: Array<[string, string]>): string {
  let text = JSON.stringify(report, null, 2);
  for (const [value, placeholder] of replacements) text = text.split(value).join(placeholder);
  return `${text}\n`;
}
async function main() {
  assertSafeRealEmbeddingChildEnv(process.env);
  for (const key of ['MODEL', 'VOCAB', 'TOKENIZER_CONFIG'])
    process.env[`SNAGLET_RERANKER_${key}_FILE`] =
      `${process.env.SNAGLET_HOME}/unavailable-reranker`;
  const { getLocalEmbedderStatus } =
    await import('@server/services/embedding/LocalEmbedderService');
  const status = await getLocalEmbedderStatus();
  if (!status.ready) throw new Error(`Model not ready: ${status.error}`);
  const { WordPieceTokenizer } = await import('@server/services/reranking/WordPieceTokenizer');
  const { embedderModelFilePath } =
    await import('@server/services/embedding/embedderModelManifest');
  const tokenizer = await WordPieceTokenizer.fromFiles(
    embedderModelFilePath('vocab'),
    embedderModelFilePath('tokenizerConfig')
  );
  const { chunkContent, contentBudgetChars } =
    await import('@server/services/embedding/chunkContent');
  const chunkAudit = Object.entries({ documentBody, codeBody, denseBody }).map(([key, body]) => ({
    key,
    chars: body.length,
    chunks: chunkContent(body, { maxChars: contentBudgetChars(512) }).map((c) => ({
      ...c,
      chars: c.text.length,
      tokens: tokenizer.encodeSingle(`search_document: ${c.text}`, 100000).inputIds.length,
      headingPresent: /^#{1,6} /m.test(c.text),
    })),
  }));
  const { Containers, Docs, getDb, closeDatabase } = await import('@snaglet/db');
  const { embedNode } = await import('@server/services/embedding/EmbeddingOrchestrator');
  const { hydrateSemanticHits } =
    await import('@server/services/ToolService/handlers/search/workspaceSearch/hydration');
  const { renderHit } =
    await import('@server/services/ToolService/handlers/search/workspaceSearch/formatters');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = await mkdtemp(path.join(tmpdir(), 'snaglet-passage-audit-'));
  const ids: string[] = [];
  try {
    const parent = await Containers.create({ name: 'Passage audit', fileIndexingEnabled: false });
    ids.push(parent.id);
    const doc = await Docs.create({
      title: 'Field handbook',
      content: documentBody,
      containerId: parent.id,
    });
    ids.push(doc.id);
    const embedded = await embedNode({ nodeId: doc.id, content: documentBody });
    if (!embedded.ok) throw new Error(JSON.stringify(embedded));
    const tool = (await import('@server/services/ToolService/tools/workspace/search/tool')).default;
    const { Projects } = await import('@snaglet/db/tables/projects');
    const { Files } = await import('@snaglet/db/tables/files');
    const { reconcileProject } = await import('@server/services/fileIndexing');
    const { embedFileContent } = await import('@server/services/embedding/fileContentEmbedding');
    const projectContainer = await Containers.create({
      name: 'Passage code audit',
      category: 'project',
      fileIndexingEnabled: true,
    });
    ids.push(projectContainer.id);
    const project = await Projects.create({
      name: 'passage-code',
      containerId: projectContainer.id,
      folderPath: root,
    });
    await writeFile(path.join(root, 'handbook.ts'), codeBody);
    await reconcileProject(project);
    const file = (await Files.listByProject(project.id))[0];
    if (!file) throw new Error('Fixture file not indexed');
    const fileEmbedded = await embedFileContent({
      contentHash: file.contentHash,
      content: codeBody,
    });
    if (!fileEmbedded.ok) throw new Error(JSON.stringify(fileEmbedded));
    const { createQueryEmbedding } = await import('@server/services/search/nodeSearch');
    const { semanticVectorCandidates } =
      await import('@server/services/ToolService/handlers/search/workspaceSearch/semanticCandidates');
    const queries = [];
    const winningChunks = [];
    for (const answer of answers) {
      const embedding = await createQueryEmbedding(answer.query);
      if (!embedding) throw new Error('No query embedding');
      winningChunks.push({
        key: answer.key,
        hits: await semanticVectorCandidates({
          query: answer.query,
          kinds: ['doc', 'file'],
          limit: 5,
          allowedContainerIds: null,
          ...embedding,
          timeRange: null,
          fileProjectId: project.id,
          filePathPrefix: null,
        }),
      });
    }
    const fileQueries = [];
    const workspaceFileQueries = [];
    for (const mode of ['keyword', 'semantic', 'hybrid'] as const)
      for (const answer of answers) {
        const input = {
          kind: 'files',
          mode,
          query: answer.query,
          project_id: project.id,
          scope_files: 'project',
          limit: 5,
        };
        const output = await tool(input, {}, { cwd: root, projectId: project.id });
        fileQueries.push({
          key: answer.key,
          input,
          output,
          articleHit: output.includes('handbook.ts'),
          passageHit: output.includes(answer.answer),
        });
        const workspaceInput = { ...input, kind: 'workspace', kinds: ['file'] };
        const workspaceOutput = await tool(
          workspaceInput,
          {},
          { cwd: root, projectId: project.id }
        );
        workspaceFileQueries.push({
          key: answer.key,
          input: workspaceInput,
          output: workspaceOutput,
          articleHit: workspaceOutput.includes('handbook.ts'),
          passageHit: workspaceOutput.includes(answer.answer),
        });
      }
    for (const mode of ['keyword', 'semantic', 'hybrid'] as const)
      for (const answer of answers) {
        const input = {
          kind: 'workspace',
          kinds: ['doc'],
          mode,
          query: answer.query,
          container_id: parent.id,
          limit: 5,
        };
        const output = await tool(input, {}, {});
        queries.push({
          key: answer.key,
          input,
          output,
          articleHit: output.includes(doc.id),
          passageHit: output.includes(answer.answer),
        });
      }
    const forced = await hydrateSemanticHits([
      {
        id: doc.id,
        kind: 'doc',
        score: 1,
        channels: ['vector'],
        chunkIndex: 3,
        chunkStart: documentBody.indexOf(answers[1].answer),
        chunkEnd: documentBody.indexOf(answers[1].answer) + answers[1].answer.length,
      },
    ]);
    const forcedOutput = renderHit(forced[0], new Map());
    const report = {
      status,
      modelWindow: 512,
      budgetChars: 1740,
      chunkAudit,
      queries,
      fileQueries,
      workspaceFileQueries,
      winningChunks,
      forcedWinningMiddleChunk: {
        output: forcedOutput,
        passageHit: forcedOutput.includes(answers[1].answer),
      },
      storedChunks: (
        await getDb().query(
          'SELECT chunk_index,chunk_start,chunk_end FROM public.embeddings WHERE node_id=$1 ORDER BY chunk_index',
          [doc.id]
        )
      ).rows,
    };
    const artifactDir = process.env.SNAGLET_SEARCH_EVAL_ARTIFACT_DIR;
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
      await writeFile(
        path.join(artifactDir, 'passage-audit.json'),
        neutralize(report, [
          [root, '/tmp/snaglet-passage-audit-XXXXXX'],
          [doc.id, 'doc-1111111111111-aaaaaaaaa'],
          [file.id, 'file-2222222222222-bbbbbbbbb'],
          [parent.id, 'container-3333333333333-ccccccccc'],
          [projectContainer.id, 'container-4444444444444-ddddddddd'],
          [project.id, 'project-5555555555555-eeeeeeeee'],
          [homedir(), '~'],
        ])
      );
    }
    console.log(JSON.stringify({ passageAudit: report }));
  } finally {
    if (ids.length) await getDb().query('DELETE FROM public.nodes WHERE id=ANY($1::text[])', [ids]);
    await closeDatabase();
    await rm(root, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
