/**
 * Sidebar badges, server/wire half: an agent PATCH must produce an event a
 * sidebar can consume, so a container's category chip and an agent's role
 * refresh without a reload. These tests inspect event generation, not
 * rendering. The no-emission cases matter as much: an event on a failed or
 * no-op write makes every window refetch for nothing.
 */

import request from 'supertest';
import express from 'express';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const docsUpdate = jest.fn();
const docsMoveTo = jest.fn();
const docsFindById = jest.fn();
const docsCreate = jest.fn();
const agentGet = jest.fn();
const agentUpdate = jest.fn();
const emitTreeNodeUpdated = jest.fn();
const emitTreeNodeCreated = jest.fn();
const emitWorkspaceEvent = jest.fn();

jest.mock('@snaglet/db', () => ({
  Docs: {
    update: (...a: unknown[]) => docsUpdate(...a),
    moveTo: (...a: unknown[]) => docsMoveTo(...a),
    findById: (...a: unknown[]) => docsFindById(...a),
    create: (...a: unknown[]) => docsCreate(...a),
  },
  Containers: { findById: jest.fn() },
}));
jest.mock('@server/realtime/surfaces/tree', () => ({
  emitTreeNodeCreated: (...a: unknown[]) => emitTreeNodeCreated(...a),
  emitTreeNodeUpdated: (...a: unknown[]) => emitTreeNodeUpdated(...a),
  emitTreeNodeDeleted: jest.fn(),
  snapshotFromDoc: (doc: Record<string, unknown>) => ({
    id: doc.id,
    kind: 'doc',
    title: doc.title,
  }),
  snapshotFromContainer: jest.fn(),
}));
jest.mock('@server/realtime/emit', () => ({
  emitWorkspaceEvent: (...a: unknown[]) => emitWorkspaceEvent(...a),
}));
jest.mock('@server/realtime/actorContext', () => ({ getCurrentActor: () => null }));
jest.mock('@server/services/HookService', () => ({ hooks: { emit: jest.fn() } }));
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { emitAgentUpdated } from '@server/realtime/surfaces/agents';
import { isWorkspaceEvent, type WorkspaceEvent } from '@snaglet/shared/types/workspace-events';

beforeEach(() => jest.clearAllMocks());

describe('agent.updated is a well-formed, receivable event', () => {
  it('broadcasts on the workspace channel with agentId and changed', () => {
    emitAgentUpdated('agent-1', ['role']);

    expect(emitWorkspaceEvent).toHaveBeenCalledWith({
      type: 'agent.updated',
      agentId: 'agent-1',
      changed: ['role'],
    });
  });

  it('is accepted by isWorkspaceEvent — the runtime guard, not just the union', () => {
    // The guard keeps its own hand-maintained discriminator list. A member
    // added to the WorkspaceEvent union but not there compiles fine and then
    // is silently dropped at every receiver.
    const event: WorkspaceEvent = {
      type: 'agent.updated',
      agentId: 'agent-1',
      changed: ['role'],
      ts: new Date().toISOString(),
      actor: { actorId: 'member-1', actorKind: 'user' },
    };

    expect(isWorkspaceEvent(event)).toBe(true);
  });

  it('drops a no-op invalidation rather than making receivers refetch for nothing', () => {
    emitAgentUpdated('agent-1', []);
    expect(emitWorkspaceEvent).not.toHaveBeenCalled();
  });

  it('drops an emission with no agent id', () => {
    emitAgentUpdated('', ['role']);
    expect(emitWorkspaceEvent).not.toHaveBeenCalled();
  });
});

describe('every WorkspaceEvent union member survives the runtime guard', () => {
  // A union member missing from isWorkspaceEvent's list is invisible to TS.
  // Enumerating the discriminators here turns that silent drop into a
  // failing test the next time someone adds an event.
  const KNOWN_TYPES = [
    'workspace.created',
    'workspace.updated',
    'workspace.deleted',
    'workspace.archived',
    'workspace.restored',
    'doc.saved',
    'file.embedding_coverage_changed',
    'file.indexing_impact_changed',
    'thread.created',
    'thread.updated',
    'thread.deleted',
    'thread.run_started',
    'thread.run_finished',
    'agent.work_started',
    'agent.work_finished',
    'agent.updated',
    'hook.run_started',
    'hook.run_finished',
    'hook.runs_changed',
    'hook.enabled_changed',
    'hook.registry_changed',
    'notification.created',
    'notification.dismissed',
  ];

  it.each(KNOWN_TYPES)('accepts %s', (type) => {
    expect(
      isWorkspaceEvent({
        type,
        ts: new Date().toISOString(),
        actor: { actorId: 'm', actorKind: 'system' },
      })
    ).toBe(true);
  });

  it('still rejects an unknown discriminator', () => {
    expect(
      isWorkspaceEvent({
        type: 'agent.invented',
        ts: new Date().toISOString(),
        actor: { actorId: 'm', actorKind: 'system' },
      })
    ).toBe(false);
  });
});
