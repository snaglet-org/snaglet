import { describe, expect, it, vi } from 'vitest';

// The API barrel's config module throws at import without these.
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import type { PaletteSearchHit } from '@desktop/utils/api';
import { formatResultMeta } from './paletteDisplay';
import { resultLocation, type ContainerPlace } from './paletteLocation';
import { serverHitToNode, toSearchResult, type SearchResult } from './paletteResultMappers';

const created = '2026-11-16T20:24:00.000Z';

function serverResult(
  kind: PaletteSearchHit['kind'],
  payload: Record<string, unknown>,
  location?: string | null
): SearchResult {
  const result = toSearchResult(
    serverHitToNode({ node_id: `${kind}-1`, kind, score: 1, channels: ['fts'], payload }),
    'server',
    ['fts']
  );
  return location === undefined ? result : { ...result, location };
}

describe('formatResultMeta', () => {
  it('names where a result lives, never its creation date', () => {
    const doc = serverResult(
      'doc',
      { title: 'Backups', createdAt: created, updatedAt: created },
      'Onboarding / Features'
    );

    expect(formatResultMeta(doc)).toBe('Onboarding / Features');
  });

  it('says nothing rather than a date while the place is unknown', () => {
    const doc = serverResult('doc', { title: 'Backups', createdAt: created, updatedAt: created });

    expect(formatResultMeta(doc)).toBeNull();
  });

  it('adds the matching text the search returned, on the same line', () => {
    const memory = serverResult('memory', {
      title: 'backup-habit',
      content: 'Takes a backup\n  before every update.',
      createdAt: created,
    });
    const tool = serverResult('tool', { name: 'Backup now', description: 'Snapshot the data.' });
    const agent = serverResult('agent', { name: 'Patty', role: 'Guide' });
    const image = serverResult(
      'image',
      { name: 'Chart', description: 'Backup sizes', tags: ['ops'], containerId: 'c' },
      'Reports'
    );

    expect(formatResultMeta(memory)).toBe('Takes a backup before every update.');
    expect(formatResultMeta(tool)).toBe('Snapshot the data.');
    expect(formatResultMeta(agent)).toBe('Guide');
    expect(formatResultMeta(image)).toBe('Reports · Backup sizes · Tags: ops');
  });

  it('names the thread a message was found in', () => {
    const message = serverResult(
      'message',
      { content: 'Where are backups kept?', threadTitle: 'Onboarding', createdAt: created },
      'Onboarding'
    );

    expect(formatResultMeta(message)).toBe('Onboarding');
  });

  it('cuts a long snippet so the row stays one line', () => {
    const memory = serverResult('memory', { title: 'long', content: 'word '.repeat(200) });

    const meta = formatResultMeta(memory) ?? '';
    expect(meta.length).toBeLessThanOrEqual(161);
    expect(meta.endsWith('…')).toBe(true);
  });
});

describe('resultLocation', () => {
  const containers = new Map<string, ContainerPlace>([
    ['c-onboarding', { name: 'Onboarding', parentId: null }],
    ['c-features', { name: 'Features', parentId: 'c-onboarding' }],
  ]);

  it('spells the folder path from the top of the workspace down', () => {
    const doc = serverHitToNode({
      node_id: 'doc-1',
      kind: 'doc',
      score: 1,
      channels: ['fts'],
      payload: { title: 'Backups', containerId: 'c-features' },
    });
    const folder = serverHitToNode({
      node_id: 'c-features',
      kind: 'container',
      score: 1,
      channels: ['fts'],
      payload: { name: 'Features', containerId: 'c-onboarding' },
    });

    expect(resultLocation(doc, containers)).toBe('Onboarding / Features');
    expect(resultLocation(folder, containers)).toBe('Onboarding');
  });

  it('calls the top level Workspace, as Home does', () => {
    const doc = serverHitToNode({
      node_id: 'doc-1',
      kind: 'doc',
      score: 1,
      channels: ['fts'],
      payload: { title: 'Loose notes', containerId: null },
    });
    const thread = serverHitToNode({
      node_id: 'thread-1',
      kind: 'thread',
      score: 1,
      channels: ['fts'],
      payload: { title: 'Plan my week', projectId: null },
    });

    expect(resultLocation(doc, containers)).toBe('Workspace');
    expect(resultLocation(thread, containers)).toBe('Workspace');
  });

  it('places a thread in its project', () => {
    const thread = serverHitToNode({
      node_id: 'thread-1',
      kind: 'thread',
      score: 1,
      channels: ['fts'],
      payload: { title: 'Kickoff', projectId: 'c-onboarding' },
    });

    expect(resultLocation(thread, containers)).toBe('Onboarding');
  });

  it('has no path while a folder is not in the loaded tree', () => {
    const doc = serverHitToNode({
      node_id: 'doc-1',
      kind: 'doc',
      score: 1,
      channels: ['fts'],
      payload: { title: 'Backups', containerId: 'c-archived' },
    });

    expect(resultLocation(doc, containers)).toBeNull();
    expect(resultLocation(doc, new Map())).toBeNull();
  });

  it('stops on a parent loop instead of hanging', () => {
    const looped = new Map<string, ContainerPlace>([
      ['a', { name: 'A', parentId: 'b' }],
      ['b', { name: 'B', parentId: 'a' }],
    ]);
    const doc = serverHitToNode({
      node_id: 'doc-1',
      kind: 'doc',
      score: 1,
      channels: ['fts'],
      payload: { title: 'Odd', containerId: 'a' },
    });

    expect(resultLocation(doc, looped)).toBeNull();
  });

  it('names the thread of a message and the kind of a table', () => {
    const message = serverHitToNode({
      node_id: 'message-1',
      kind: 'message',
      score: 1,
      channels: ['fts'],
      payload: { content: 'hi', threadTitle: 'Plan my week' },
    });
    const untitled = serverHitToNode({
      node_id: 'message-2',
      kind: 'message',
      score: 1,
      channels: ['fts'],
      payload: { content: 'hi', threadTitle: null },
    });
    const table = serverHitToNode({
      node_id: 'table-1',
      kind: 'table',
      score: 1,
      channels: ['fts'],
      payload: { name: 'ideas', origin: 'custom' },
    });

    expect(resultLocation(message, containers)).toBe('Plan my week');
    expect(resultLocation(untitled, containers)).toBe('Untitled thread');
    expect(resultLocation(table, containers)).toBe('Your table');
  });
});
