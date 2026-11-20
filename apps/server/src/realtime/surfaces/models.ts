/**
 * Model catalog surface: `models.changed` on the workspace channel, payload
 * the provider whose catalog changed. Sent after every write to the `models`
 * table that a person or agent can cause: a discovery pass (after a key is
 * saved, imported, tested or signed in), the model routes (create, bulk
 * import, edit, remove) and the agent `model` tool's add. It carries no rows:
 * clients showing model lists (the Get started model step, an agent's model
 * picker, the Providers sidebar) re-read them over REST.
 */
import { emitWorkspaceEvent } from '@server/realtime/emit';

/** Announce that `providerId`'s model catalog changed. */
export function emitModelsChanged(providerId: string): void {
  if (!providerId) return;
  emitWorkspaceEvent({ type: 'models.changed', providerId });
}
