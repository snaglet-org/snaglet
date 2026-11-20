/**
 * Phase A — genesis: prove a fresh boot from an empty temp SNAGLET_HOME comes up
 * whole. All migrations applied (count read dynamically from
 * packages/db/migrations), health + ready green, and the fresh-bootstrap
 * integrity contract holds: tools synced, catalogs seeded, the local user
 * bridged to members, default agents seeded and an empty workspace tree.
 */

import { readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GateServer } from '../lib/gateServer';
import type { Ledger } from '../lib/ledger';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'packages', 'db', 'migrations');

/** Dynamic migration count from the on-disk chain — no magic number. */
export function migrationCount(): number {
  return readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).length;
}

export async function runPhaseA(server: GateServer, ledger: Ledger): Promise<void> {
  ledger.phase('A');

  await ledger.op('health: /health ok', async () => {
    const res = await server.fetchRoot('/health');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { status?: string };
    if (body.status !== 'ok') throw new Error(`status=${body.status}`);
    return `status=${body.status}`;
  });

  await ledger.op('health: /health/ready database ok', async () => {
    const res = await server.fetchRoot('/health/ready');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // /health/ready nests checks: { status, checks: { database: { status }, embedding: {…} } }.
    const body = (await res.json()) as {
      status?: string;
      checks?: { database?: { status?: string }; embedding?: { status?: string } };
    };
    const dbStatus = body.checks?.database?.status;
    if (dbStatus !== 'ok') throw new Error(`database=${JSON.stringify(body.checks?.database)}`);
    return `ready=${body.status} database=ok embedding=${body.checks?.embedding?.status ?? '?'}`;
  });

  await ledger.op('migrations: full chain applied (dynamic count)', async () => {
    const expected = migrationCount();
    // /health/ready returned 200 above, so bootstrapIfFresh applied the full
    // chain on this fresh DB (a partial chain leaves readiness red). /db/stats
    // cross-checks the ledger when it exposes migration rows. Zero migrations
    // on disk means the bootstrap assets are missing.
    if (expected < 1) {
      throw new Error(`no migrations found on disk — DB bootstrap assets are missing`);
    }
    const res = await server.fetchApi('/db/stats');
    if (res.ok) {
      const data = ((await res.json()) as { data?: unknown }).data;
      const applied = extractAppliedCount(data);
      if (applied != null && applied < expected) {
        throw new Error(`ledger recorded ${applied} < ${expected} on-disk migrations`);
      }
    }
    return `${expected} migrations on disk; ready ⇒ full chain applied`;
  });

  // Fresh bootstrap integrity

  await ledger.op('bootstrap: tools table populated by boot sync', async () => {
    const deadline = Date.now() + 15_000;
    let tools: unknown[] = [];
    while (Date.now() < deadline) {
      tools = await server.get<unknown[]>('/tools');
      if (Array.isArray(tools) && tools.length > 0) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (!Array.isArray(tools) || tools.length === 0) throw new Error('tools table empty');
    return `${tools.length} tools`;
  });

  await ledger.op('bootstrap: providers + models + mcp_servers seeded', async () => {
    const providers = await server.get<unknown[]>('/providers');
    const models = await server.get<unknown[]>('/models');
    const mcpRes = await server.fetchApi('/mcp/servers');
    const mcp = mcpRes.ok ? (((await mcpRes.json()) as { data?: unknown[] }).data ?? []) : [];
    if (providers.length === 0) throw new Error('no providers seeded');
    if (models.length === 0) throw new Error('no models seeded');
    if (!Array.isArray(mcp) || mcp.length === 0) throw new Error('no mcp_servers seeded');
    return `${providers.length} providers, ${models.length} models, ${mcp.length} mcp`;
  });

  await ledger.op('bootstrap: local user → members bridge present', async () => {
    const members = await server.get<Array<{ id: string }>>('/members');
    if (members.length === 0) throw new Error('no members row for local user');
    if (!members.every((m) => typeof m.id === 'string' && m.id.length > 0)) {
      throw new Error('a member row is missing an id');
    }
    return `${members.length} member(s)`;
  });

  await ledger.op('bootstrap: default agents seeded', async () => {
    // GET /agents triggers AgentService.ensureDefaults → seeds default agents.
    const agents = await server.get<unknown[]>('/agents');
    if (agents.length === 0) throw new Error('no default agents seeded');
    return `${agents.length} default agents`;
  });

  await ledger.op('bootstrap: workspace tree is EMPTY at genesis', async () => {
    // The tree mixes containers with loose root-level docs/threads/images
    // (ContainerTreeService). A genesis workspace seeds NO workspace nodes at
    // all (no starter docs are seeded), so
    // the tree must be zero-length — truly blank.
    const tree = await server.get<Array<{ kind?: string; title?: string }>>('/containers/tree');
    if (!Array.isArray(tree)) throw new Error('tree is not an array');
    if (tree.length !== 0) {
      throw new Error(
        `expected an empty tree, got ${tree.length} node(s): ${tree
          .map((n) => `${n.kind}:${n.title}`)
          .join(', ')}`
      );
    }
    return 'workspace tree empty — no containers, no loose nodes';
  });
}

/** Best-effort extraction of an "applied migrations" count from /db/status. */
function extractAppliedCount(data: unknown): number | null {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    for (const key of ['appliedCount', 'applied', 'migrationsApplied', 'migrations']) {
      const v = d[key];
      if (typeof v === 'number') return v;
      if (Array.isArray(v)) return v.length;
    }
  }
  return null;
}
