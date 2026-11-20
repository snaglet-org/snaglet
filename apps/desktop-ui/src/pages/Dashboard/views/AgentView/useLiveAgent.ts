/**
 * The agent pane's copy of its agent, kept live.
 *
 * Holds the agent as the server has it, saves partial updates, and applies
 * changes made anywhere else (another agent's tool call, an automation, a
 * script, another window) while the pane is open:
 *
 * - A field the user is not editing takes the new value at once and pulses
 *   briefly, so the change is noticed.
 * - A free-text field the user is editing (focused, or holding an unsaved
 *   draft) keeps what the user sees. The field gets a `LiveConflict`, and
 *   shows "Updated by … just now" with Reload / Keep mine. Until the user
 *   picks, that field's editor is fed the value it had (`held`) and its saves
 *   wait, so nothing is overwritten either way.
 * - Saves of a text field also wait from the moment an event names it until
 *   its refetch lands (`gates`), so a draft cannot be written over a change
 *   the pane has not seen yet.
 * - The pane's own saves never read as someone else's change: their echo
 *   carries a revision the pane already holds, and a save's response only
 *   updates the fields that save wrote.
 * - A deleted agent sets `deleted`; an archived one shows in `agent.archived`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SnagletAgent } from '@snaglet/shared/types';
import type { Actor } from '@snaglet/shared/types/workspace-events';
import { agentsApi } from '@desktop/utils/api';
import {
  AGENT_DRAFT_FIELDS,
  adoptSavedFields,
  changedLiveFields,
  describeActor,
  draftFieldValue,
  isNotFound,
  liveFieldOfKey,
  type AgentDraftField,
  type AgentLiveField,
  type ConflictChoice,
  type EditingProbe,
  type LiveConflict,
  type SaveGate,
} from './agentLiveFields';
import { useAgentLiveSync, type AgentSaveTracker } from './useAgentLiveSync';

type AgentPatch = Parameters<typeof agentsApi.update>[1];
type HeldField = Exclude<AgentDraftField, 'role'>;

/** How long a field stays highlighted after a remote change. */
const AGENT_LIVE_PULSE_MS = 1600;

export interface LiveAgent {
  agent: SnagletAgent;
  /** The agent was deleted while the pane was open. */
  deleted: boolean;
  /** Persist a partial update; the pane takes the fields it wrote. */
  saveFields: (patch: AgentPatch) => Promise<void>;
  /** Remote changes waiting on the user's choice, per draft field. */
  conflicts: Partial<Record<AgentDraftField, LiveConflict>>;
  /** The saved value a prompt editor keeps showing while its conflict is open. */
  held: Partial<Record<HeldField, string>>;
  /** The user picked Reload or Keep mine: the field follows the server again. */
  resolveConflict: (field: AgentDraftField, choice?: ConflictChoice) => void;
  /** A prompt editor closing with a conflict open leaves its draft here. */
  keepDraft: (field: HeldField, text: string) => void;
  /** Per draft field: true while its saves must wait (a change is on its way or open). */
  gates: Record<AgentDraftField, SaveGate>;
  /** Draft fields named by a change whose refetch has not landed yet. */
  waiting: ReadonlySet<AgentDraftField>;
  /** Fields that just changed remotely. */
  pulsing: ReadonlySet<AgentLiveField>;
  /** Highlight a field that a section refreshed itself (skills). */
  pulse: (field: AgentLiveField) => void;
  /** Each draft field sets its probe: is the user editing it right now? */
  probes: Record<AgentDraftField, EditingProbe>;
}

function creditFor(field: AgentLiveField, actors: ReadonlyMap<string, Actor>): Actor | null {
  let credited: Actor | null = null;
  for (const [key, actor] of actors) if (liveFieldOfKey(key) === field) credited = actor;
  return credited;
}

function isDraftField(field: string | null): field is AgentDraftField {
  return field !== null && (AGENT_DRAFT_FIELDS as readonly string[]).includes(field);
}

export function useLiveAgent(initial: SnagletAgent): LiveAgent {
  const [agent, setAgentState] = useState<SnagletAgent>(initial);
  const agentRef = useRef(agent);
  const setAgent = useCallback((next: SnagletAgent) => {
    agentRef.current = next;
    setAgentState(next);
  }, []);
  const [deleted, setDeleted] = useState(false);
  const [conflicts, setConflictsState] = useState<LiveAgent['conflicts']>({});
  const conflictsRef = useRef(conflicts);
  const [held, setHeldState] = useState<LiveAgent['held']>({});
  const heldRef = useRef(held);
  const [pulsing, setPulsing] = useState<ReadonlySet<AgentLiveField>>(new Set());
  const pulseTimers = useRef(new Map<AgentLiveField, ReturnType<typeof setTimeout>>());
  const probes = useMemo<LiveAgent['probes']>(
    () => ({
      role: { current: null },
      identity: { current: null },
      systemPrompt: { current: null },
    }),
    []
  );

  // Save gates: read synchronously by the fields at save time, so they are
  // refs kept in step with `incoming` and `conflicts` as those change.
  const gates = useMemo<LiveAgent['gates']>(
    () => ({
      role: { current: false },
      identity: { current: false },
      systemPrompt: { current: false },
    }),
    []
  );
  const incomingRef = useRef(new Set<AgentDraftField>());
  const [waiting, setWaiting] = useState<ReadonlySet<AgentDraftField>>(new Set());
  const syncGates = useCallback(() => {
    for (const field of AGENT_DRAFT_FIELDS) {
      gates[field].current =
        incomingRef.current.has(field) || conflictsRef.current[field] !== undefined;
    }
  }, [gates]);

  const setConflicts = useCallback(
    (next: LiveAgent['conflicts']) => {
      conflictsRef.current = next;
      syncGates();
      setConflictsState(next);
    },
    [syncGates]
  );
  const setHeld = useCallback((next: LiveAgent['held']) => {
    heldRef.current = next;
    setHeldState(next);
  }, []);

  // Saves in flight, and who waits for them to settle.
  const inFlight = useRef(0);
  const started = useRef(0);
  const waiters = useRef<Array<() => void>>([]);
  const saves = useMemo<AgentSaveTracker>(
    () => ({
      started: () => started.current,
      settled: () =>
        inFlight.current === 0
          ? Promise.resolve()
          : new Promise<void>((resolve) => waiters.current.push(resolve)),
    }),
    []
  );

  const saveFields = useCallback(
    async (patch: AgentPatch) => {
      inFlight.current += 1;
      started.current += 1;
      try {
        const saved = await agentsApi.update(agentRef.current.id, patch);
        setAgent(adoptSavedFields(agentRef.current, saved, patch));
      } finally {
        inFlight.current -= 1;
        if (inFlight.current === 0) {
          const ready = waiters.current.splice(0);
          for (const resolve of ready) resolve();
        }
      }
    },
    [setAgent]
  );

  const pulse = useCallback((field: AgentLiveField) => {
    const timers = pulseTimers.current;
    const existing = timers.get(field);
    if (existing) clearTimeout(existing);
    setPulsing((prev) => (prev.has(field) ? prev : new Set(prev).add(field)));
    timers.set(
      field,
      setTimeout(() => {
        timers.delete(field);
        setPulsing((prev) => {
          const next = new Set(prev);
          next.delete(field);
          return next;
        });
      }, AGENT_LIVE_PULSE_MS)
    );
  }, []);

  useEffect(() => {
    const timers = pulseTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const resolveConflict = useCallback(
    (field: AgentDraftField, choice: ConflictChoice = {}) => {
      const current = conflictsRef.current[field];
      if (choice.keptOver && current && current !== choice.keptOver) {
        // A newer change arrived while the user was keeping theirs: it stays
        // open, now over the text they kept.
        if (field !== 'role' && choice.kept !== undefined) {
          setHeld({ ...heldRef.current, [field]: choice.kept });
        }
        return;
      }
      if (current) {
        const next = { ...conflictsRef.current };
        delete next[field];
        setConflicts(next);
      }
      if (field !== 'role' && field in heldRef.current) {
        const next = { ...heldRef.current };
        delete next[field];
        setHeld(next);
      }
    },
    [setConflicts, setHeld]
  );

  const keepDraft = useCallback(
    (field: HeldField, text: string) => {
      if (!conflictsRef.current[field] || heldRef.current[field] === text) return;
      setHeld({ ...heldRef.current, [field]: text });
    },
    [setHeld]
  );

  // Counts live refetches applied, so an older mount hydration never lands on a newer one.
  const freshApplied = useRef(0);
  const applyFresh = useCallback(
    (fresh: SnagletAgent, actors: ReadonlyMap<string, Actor>) => {
      freshApplied.current += 1;
      const prev = agentRef.current;
      const nextConflicts = { ...conflictsRef.current };
      const nextHeld = { ...heldRef.current };
      const toPulse: AgentLiveField[] = [];
      for (const field of changedLiveFields(prev, fresh)) {
        const draftField = isDraftField(field) ? field : null;
        const editing =
          draftField !== null &&
          (nextConflicts[draftField] !== undefined || probes[draftField].current?.() === true);
        if (!draftField || !editing) {
          toPulse.push(field);
          continue;
        }
        const remote = draftFieldValue(draftField, fresh);
        if (draftField !== 'role' && !(draftField in nextHeld)) {
          nextHeld[draftField] = draftFieldValue(draftField, prev);
        }
        if (draftField !== 'role' && nextHeld[draftField] === remote) {
          // Changed back to what the editor already shows: nothing to choose,
          // and the field's waiting saves go through.
          delete nextHeld[draftField];
          delete nextConflicts[draftField];
          continue;
        }
        nextConflicts[draftField] = { remote, by: describeActor(creditFor(field, actors)) };
      }
      setAgent(fresh);
      setConflicts(nextConflicts);
      setHeld(nextHeld);
      for (const field of toPulse) pulse(field);
    },
    [probes, pulse, setAgent, setConflicts, setHeld]
  );

  const onIncoming = useCallback(
    (keys: readonly string[] | 'all') => {
      const fields =
        keys === 'all' ? AGENT_DRAFT_FIELDS : keys.map(liveFieldOfKey).filter(isDraftField);
      if (fields.length === 0) return;
      for (const field of fields) incomingRef.current.add(field);
      syncGates();
      setWaiting(new Set(incomingRef.current));
    },
    [syncGates]
  );

  const onIdle = useCallback(() => {
    if (incomingRef.current.size === 0) return;
    incomingRef.current.clear();
    syncGates();
    setWaiting(new Set());
  }, [syncGates]);

  // Pane selections are persisted in localStorage, including the agent
  // snapshot that was current when the pane was opened. After a reload that
  // snapshot can be older than the database, so hydrate from the per-id API
  // instead of treating the persisted selection as canonical. A save or a
  // live refetch that lands first wins: the hydration was requested before it.
  useEffect(() => {
    let canceled = false;
    const savesAtStart = started.current;
    const freshAtStart = freshApplied.current;
    void agentsApi
      .get(initial.id)
      .then((fresh) => {
        if (
          !canceled &&
          started.current === savesAtStart &&
          inFlight.current === 0 &&
          freshApplied.current === freshAtStart
        ) {
          setAgent(fresh);
        }
      })
      .catch((err: unknown) => {
        if (canceled) return;
        if (isNotFound(err)) {
          setDeleted(true);
          return;
        }
        // Keep the supplied snapshot visible if the refresh fails.
        console.error('AgentView: failed to refresh agent', err);
      });
    return () => {
      canceled = true;
    };
  }, [initial.id, setAgent]);

  useAgentLiveSync({
    agentId: initial.id,
    heldRevision: () => agentRef.current.updatedAt,
    saves,
    onFresh: applyFresh,
    onGone: () => setDeleted(true),
    onIncoming,
    onIdle,
  });

  return {
    agent,
    deleted,
    saveFields,
    conflicts,
    held,
    resolveConflict,
    keepDraft,
    gates,
    waiting,
    pulsing,
    pulse,
    probes,
  };
}
