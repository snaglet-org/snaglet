import { readFileSync } from 'node:fs';
import path from 'node:path';
import corpusShape from './corpus.json';
import queriesShape from './queries.json';
export type WikipediaMode =
  | 'keyword-baseline'
  | 'mocked-hybrid-pipeline'
  | 'real-embeddings-hybrid';
export type WikipediaDocument = (typeof corpusShape.documents)[number];
export type WikipediaQuery = (typeof queriesShape.queries)[number];
export function loadWikipediaFixtures(): { corpus: typeof corpusShape; queries: WikipediaQuery[] } {
  return {
    corpus: JSON.parse(readFileSync(path.join(__dirname, 'corpus.json'), 'utf8')),
    queries: JSON.parse(readFileSync(path.join(__dirname, 'queries.json'), 'utf8')).queries,
  };
}
export function wikipediaDocumentBody(doc: WikipediaDocument): string {
  return `${doc.content}\n\n${doc.attributionNote}`;
}
export function effectiveWikipediaInput(
  query: WikipediaQuery,
  mode: WikipediaMode,
  scope: { parentId: string; projectIds: Map<string, string> }
) {
  const containerId = query.scope ? scope.projectIds.get(query.scope.projectKey) : scope.parentId;
  if (!containerId) throw new Error('Unknown project scope');
  return {
    kind: 'workspace',
    kinds: ['doc'],
    query: query.input.query,
    mode: mode === 'keyword-baseline' ? 'keyword' : 'hybrid',
    limit: 10,
    container_id: containerId,
  };
}
/** Doc-only renderer contract; deliberately independent of the DB-backed baseline runner. */
export function parseWikipediaOutput(output: string, ids: Map<string, string>): string[] {
  if (output.trim() === 'No results found.' || /^No results for "[^\n]*"\.$/.test(output.trim()))
    return [];
  if (/^(Error|Invalid|Unknown|Access denied)/im.test(output))
    throw new Error('Search error output');
  const headers = [...output.matchAll(/^📄\s+\[[^\]]+\]\((?:doc:)?([^()\s]+)\)/gm)];
  if (!headers.length) throw new Error(`Malformed search output: ${output}`);
  return headers.map((match) => {
    const id = match[1].replace(/^doc-/, '');
    return ids.get(id) ?? id;
  });
}
export function assertWikipediaScope(
  hits: string[],
  projectKey: string | undefined,
  projects: Map<string, string>
): void {
  for (const hit of hits) {
    const project = projects.get(hit);
    if (!project || (projectKey && project !== projectKey))
      throw new Error(`Unknown or out-of-scope hit: ${hit}`);
  }
}
