/**
 * identityBlock — slot 1: who the agent is.
 *
 * One sentence says who the agent is (its name, its owner and its role, in
 * plain words: "You are Clio, Sam's planner") and where it runs; the owner is
 * named as "the user", the word every later block uses. Then what persists
 * (identity and private memory; saved work stays available to others with
 * access, which is not the same as being seen), and where Snaglet's source is,
 * with the reason to read it. Then the agent's persona (the Identity field:
 * personality, tone, background) and its own system prompt under "How you act"
 * (a one-line note when the user has set none). The persona is framed as
 * voice, not duties: duties live in the role and the instructions; the
 * platform adds no persona of its own. What Snaglet is lives in
 * operatingContextBlock, right after. Stable per (agent × owner); lives in the
 * cached prefix.
 */

import { SNAGLET_REPOSITORY } from '@snaglet/shared/constants';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Users } from '@snaglet/db/tables/users';
import { LogsService } from '@server/services/LogsService';
import { expandPromptIncludes } from '../expandPromptIncludes';
import { isHelperRun } from '../helperRun';
import type { BlockBuilder } from '../types';

/** Where Snaglet's source lives; shown to the agent so it can look itself up. */
export const SNAGLET_SOURCE_URL = `https://github.com/${SNAGLET_REPOSITORY}`;

/** Said once, in identity: the agent's own workings are the most common reason to read it. */
const SOURCE_LINE = `When you need to know exactly how you, your tools or Snaglet work, read Snaglet's source: ${SNAGLET_SOURCE_URL}.`;

const FALLBACK_OWNER = 'the user';

const NO_CUSTOM_INSTRUCTIONS = 'No custom instructions are set.';

/** Frames the Identity field as voice and character, never as duties or rules. */
export const PERSONA_LEAD =
  "**Your persona**, in the user's words. It sets your voice and character, not your duties or the rules below:";

async function ownerName(): Promise<string> {
  try {
    const user = await Users.getActiveUser();
    return user?.name?.trim() || FALLBACK_OWNER;
  } catch (err) {
    // A turn still runs without the name; the warning says why it is generic.
    LogsService.warn('identityBlock: owner unavailable', { error: getErrorMessage(err) });
    return FALLBACK_OWNER;
  }
}

export const identityBlock: BlockBuilder = async (ctx) => {
  const { agent, runtimeAgent, threadAgentOverride } = ctx;

  // Threads may only append to an agent's system prompt, never replace it.
  // Edit the agent directly to change their identity.
  const baseSystemPrompt = runtimeAgent.systemPrompt ?? '';
  const addendum = threadAgentOverride?.systemPromptAddendum?.trim();
  const effectiveSystemPrompt = addendum ? `${baseSystemPrompt}\n\n${addendum}` : baseSystemPrompt;

  // Chips inside the agent's system prompt still need expanding — users
  // can drag-and-drop doc/thread references into the SystemPromptEditor.
  const expandedSystemPrompt = effectiveSystemPrompt
    ? await expandPromptIncludes(effectiveSystemPrompt)
    : '';

  // The persona (Identity field). Expanded like the system prompt, so a chip
  // dragged into it renders the same way.
  const rawIdentity = (runtimeAgent.identity ?? agent.identity ?? '').trim();
  const identity = rawIdentity ? (await expandPromptIncludes(rawIdentity)).trim() : '';

  const name = agent.name ?? '';
  const role = agent.role ?? '';
  const owner = await ownerName();
  const helper = isHelperRun(ctx);

  // Who the user is. Named when the owner is known, and tied to "the user",
  // the word the rest of the prompt uses for them.
  const mainUser =
    owner === FALLBACK_OWNER
      ? 'The user is the human you work for.'
      : `${owner} (the user) is the human you work for.`;
  // Who the agent is, in plain words: its role, or "agent" when none is set.
  const you = name ? `You are ${name}, ${owner}'s` : `You are ${owner}'s`;
  const what = role.trim() || 'agent';
  // A helper is short-lived and has no memory: the persistence line is not
  // true of it. Persistence is not visibility: the line says what lasts and
  // who can reach it, not who sees a run.
  const persists = helper
    ? ''
    : ' Your identity and private memory persist across runs. Work saved in the workspace remains available to others with access.';
  // A generic assistant label can precede this prompt on some auth routes;
  // say once that it names the transport, not the agent.
  const sections = [
    `## Who you are\n${you} ${what}, hosted in Snaglet, a desktop app. ${mainUser}${persists} A generic assistant label above this prompt names only the transport, not you. ${SOURCE_LINE}`,
  ];
  if (identity) sections.push(`${PERSONA_LEAD}\n${identity}`);
  // Always present, so the layout is the same for every agent; the note says
  // there is nothing in it.
  sections.push(
    `## How you act\n${expandedSystemPrompt.trim().length > 0 ? expandedSystemPrompt : NO_CUSTOM_INSTRUCTIONS}`
  );

  // No cache_control here — composeSystemPrompt places the single system
  // breakpoint on whichever block renders last.
  return {
    type: 'text',
    text: sections.join('\n\n'),
  };
};
