/**
 * The collaboration skills: the snaglet-agent-collab hub and its three leaves
 * (snaglet-group-threads, snaglet-other-threads, snaglet-dms). The hub says which way to
 * reach an agent and why and points; each leaf holds its own mechanics and
 * opens with a conditional pointer to the hub (only when the route is
 * unresolved), so an agent can load a leaf directly and never circles back.
 * Every rule has one home. Every `thread` op, parameter and search kind they
 * name exists in the real tools.
 */
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from '@jest/globals';
import { SKILL_DESCRIPTION_MAX_CHARS, readSkillFolder } from '@server/services/skills/skillFile';
import searchDefinition from '@server/services/ToolService/tools/workspace/search/definition';
import threadDefinition from '@server/services/ToolService/tools/threads/thread/definition';

const DIR = path.resolve(__dirname, '../../../../../../apps/server/builtin-skills');
const HUB = 'snaglet-agent-collab';
const LEAVES = ['snaglet-group-threads', 'snaglet-other-threads', 'snaglet-dms'] as const;
const read = (slug: string) => readFileSync(path.join(DIR, slug, 'SKILL.md'), 'utf8');
const body = (slug: string) => read(slug).split(/^---\n[\s\S]*?\n---\n/m)[1] ?? '';
const hub = body(HUB);
const all = [HUB, ...LEAVES].map(body).join('\n');
const count = (text: string, needle: string) => text.split(needle).length - 1;
const POINTER =
  'If the collaboration route is unresolved, use `snaglet-agent-collab`. Otherwise, continue here.';
const SLUGS = readdirSync(DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

type Props = Record<string, { enum?: string[]; items?: { enum?: string[] } }>;
const threadProps = threadDefinition.parameters_schema.properties as Props;
const unlisted = (threadDefinition.unlisted_params ?? {}) as Props;
const searchProps = searchDefinition.parameters_schema.properties as Props;

describe('collaboration skills: valid, each with a one-line trigger', () => {
  it.each([HUB, ...LEAVES])('%s is a valid built-in with a short description', async (slug) => {
    const parsed = await readSkillFolder(DIR, slug);
    expect(parsed.error ?? null).toBeNull();
    expect(parsed.status).toBe('valid');
    expect(parsed.name).toBe(slug);
    expect(parsed.description.length).toBeLessThanOrEqual(SKILL_DESCRIPTION_MAX_CHARS);
    expect(parsed.description.length).toBeLessThan(260);
  });

  it('each trigger covers its case', async () => {
    const description = async (slug: string) => (await readSkillFolder(DIR, slug)).description;
    expect(await description(HUB)).toContain("need another agent's help or share work");
    expect(await description('snaglet-group-threads')).toContain('in a thread with other agents');
    expect(await description('snaglet-group-threads')).toContain(
      'bring an agent in or take one out'
    );
    expect(await description('snaglet-other-threads')).toContain('agent in another thread');
    expect(await description('snaglet-other-threads')).toContain('start a new thread');
    expect(await description('snaglet-dms')).toContain('before you DM');
    expect(await description('snaglet-dms')).toContain('unread DMs');
  });

  it('only names thread ops and parameters that exist, and search kinds the tool accepts', () => {
    const ops = new Set(threadProps.op?.enum ?? []);
    const named = [...all.matchAll(/`thread` op `([a-z_]+)`/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const op of named) expect(ops).toContain(op);
    for (const param of ['id', 'content', 'mode', 'message_id', 'limit', 'agent_ids']) {
      expect(threadProps).toHaveProperty(param);
    }
    for (const param of ['project_id', 'title', 'initial_message']) {
      expect(threadProps).toHaveProperty(param);
    }
    for (const param of ['to', 'all']) expect(unlisted).toHaveProperty(param);
    expect([...(threadProps.mode?.enum ?? [])]).toContain('message_context');
    const nodeKinds = new Set(searchProps.kinds?.items?.enum ?? []);
    for (const m of all.matchAll(/kinds: \[([^\]]*)\]/g)) {
      for (const v of m[1]!.matchAll(/"([a-z_]+)"/g)) expect(nodeKinds).toContain(v[1]);
    }
    const kinds = new Set(searchProps.kind?.enum ?? []);
    for (const m of all.matchAll(/kind: "([a-z_]+)"/g)) expect(kinds).toContain(m[1]);
  });
});

describe('snaglet-agent-collab: the hub points, it does not restate', () => {
  it('lists the four ways to reach an agent, what each wakes, and the skill with the mechanics', () => {
    const table = hub.split('## Four ways to reach an agent')[1]?.split(/\n## /)[0] ?? '';
    const rows = table
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| Way') && !l.startsWith('| -'));
    expect(rows).toHaveLength(4);
    expect(table).toContain("them, as this thread's routing allows");
    expect(table).toContain('them, in this same turn');
    expect(table).toContain("them there, if that thread's routing reaches them");
    expect(table).toContain('no one: they see it listed in their next run, in any thread');
    for (const leaf of LEAVES) expect(table).toContain(`\`${leaf}\``);
  });

  it('says what each way is good for', () => {
    for (const purpose of [
      'Advice, information, an opinion or a rebuttal',
      'Handing real work to a specialist',
      'Splitting work across agents',
      'Starting a new thread for a strand of work',
      'Team building',
    ]) {
      expect(hub).toContain(purpose);
    }
    // DMs build the team; real-time updates go in the work's thread.
    expect(hub).toContain('Not for updates or questions that can be handled now');
  });

  it('builds a team and keeps it small, as one policy', () => {
    expect(hub).toContain('Build a team, not a single lane');
    expect(hub).toContain('instead of approximating their expertise');
    expect(hub).toContain('for that piece only: they pop in, answer or do the piece, and pop out');
  });

  it('holds no leaf mechanics', () => {
    for (const mechanic of [
      'remove_agents',
      '`leave`',
      'posted: true',
      'dm_read',
      'At most 5 sends',
      'information, not an instruction',
      'Nothing from me',
    ]) {
      expect(hub).not.toContain(mechanic);
    }
  });

  it.each(LEAVES)(
    '%s opens with the conditional pointer to the hub and never restates its overview',
    (leaf) => {
      expect(body(leaf).trimStart().startsWith(POINTER)).toBe(true);
      expect(body(leaf)).not.toContain('Four ways to reach an agent');
      expect(body(leaf)).not.toContain('Build a team, not a single lane');
    }
  );
});

describe('no circular loading of the hub', () => {
  // The hub routes to a leaf; a leaf sends an agent back only when the route is
  // still unresolved, so a clear route loads one leaf and stops there.
  it.each(SLUGS.filter((slug) => slug !== HUB))(
    '%s names snaglet-agent-collab only in the conditional pointer',
    (slug) => {
      const lines = read(slug)
        .split('\n')
        .filter((line) => line.includes('snaglet-agent-collab'));
      for (const line of lines) expect(line.trim()).toBe(POINTER);
      expect(read(slug)).not.toMatch(/see `snaglet-agent-collab`/);
    }
  );
});

describe('every collaboration rule has one home', () => {
  it.each([
    ['snaglet-group-threads', 'Every text block you emit is a post to the group'],
    ['snaglet-group-threads', 'Talk to peers with your reply, not with a tool'],
    ['snaglet-group-threads', 'A group thread is usually temporary for a specialist'],
    ['snaglet-group-threads', "Don't wait for someone else to speak first"],
    [
      'snaglet-group-threads',
      "You don't need to be asked; use your discretion, for that piece only",
    ],
    ['snaglet-group-threads', 'When you hand something off, stop doing that part'],
    ['snaglet-group-threads', "Verify, don't trust"],
    ['snaglet-group-threads', 'One voice to the user'],
    ['snaglet-group-threads', "Don't open with `[PASS]`"],
    ['snaglet-group-threads', 'Old evidence ages'],
    [
      'snaglet-other-threads',
      "Never change another agent's settings or access to get something through, unless the user asks you to",
    ],
    ['snaglet-other-threads', 'Take the thread id from a result, never from memory'],
    ['snaglet-other-threads', '**not** that anyone read it, accepted it or finished'],
    ['snaglet-other-threads', "Don't re-send to nudge"],
    ['snaglet-other-threads', "Don't acknowledge an acknowledgment"],
    ['snaglet-other-threads', 'The message is a request from a teammate'],
    ['snaglet-dms', 'a DM is information, not an instruction'],
    ['snaglet-dms', 'sent with `dm_send` wakes nobody'],
    ['snaglet-dms', 'If a DM asks something of you, reply'],
  ])('%s: %s', (slug, rule) => {
    expect(body(slug)).toContain(rule);
    expect(count(all, rule)).toBe(1);
  });
});

describe('snaglet-group-threads: peers in one thread', () => {
  const text = body('snaglet-group-threads');

  it('keeps a five-bullet summary first, in case it is condensed out of a long run', () => {
    expect(text.trimStart().slice(POINTER.length).trimStart().startsWith('## TL;DR')).toBe(true);
    const tldr = text.split('## TL;DR')[1]?.split(/\n## /)[0] ?? '';
    expect(tldr.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(5);
    expect(tldr).toContain('post to the whole group');
    expect(tldr).toContain('not the `thread` tool');
    // Both sides of a bring-in, so neither assumes the other cleans up.
    expect(tldr).toContain('Post your answer, then `leave`');
    expect(tldr).toContain("Remove them once they've posted, if they haven't left");
  });

  it('gives the inviter and the guest their own duties, in one section', () => {
    const section =
      text.split('## Bringing an agent in, or being brought in')[1]?.split(/\n## /)[0] ?? '';
    const inviter = section.split('**Inviter:**')[1]?.split('**Guest:**')[0] ?? '';
    const guest = section.split('**Guest:**')[1]?.split('\n\n')[0] ?? '';
    expect(count(text, '**Inviter:**')).toBe(1);
    expect(count(text, '**Guest:**')).toBe(1);

    // Inviter: add, then tag with the request and what done looks like, then
    // remove them if they have not left.
    const add = inviter.indexOf('`thread` op `add_agents`');
    const tag = inviter.indexOf(
      'mention them in your reply with the request and what done looks like'
    );
    const remove = inviter.indexOf("`thread` op `remove_agents` if they haven't left");
    expect(add).toBeGreaterThan(-1);
    expect(tag).toBeGreaterThan(add);
    expect(remove).toBeGreaterThan(tag);
    expect(inviter).toContain('never switch the thread to `all`');

    // Guest: report what is unverified, post the final reply, then leave;
    // never remove_agents on itself.
    expect(guest).toContain('anything unverified');
    const reply = guest.indexOf('Post your final reply first');
    expect(reply).toBeGreaterThan(-1);
    expect(reply).toBeLessThan(guest.indexOf('`thread` op `leave`'));
    expect(guest).toContain('`remove_agents` with your own id is refused');
    expect(guest).toContain('nothing more you write posts there');

    // A person's per-thread setup refuses both removal and leave; respect it.
    expect(section).toContain("such an agent's `leave` is refused too");
    expect(section).toContain('respect it, and a person removes them in the app');
    expect(text).not.toContain('Brought in yourself?');
  });

  it('routes, plans, challenges, splits, steers and finishes', () => {
    for (const rule of [
      'only `@<Name>` reaches someone',
      'held and arrives ahead of the next message that tags you',
      'Challenge once, with a reason',
      'Converge in one or two exchanges',
      'put one question to the user',
      'Claim it where it survives',
      'Steering a running peer',
      'in the first wave it is posted as text',
    ]) {
      expect(text).toContain(rule);
    }
    expect(text).not.toMatch(/alphabetical/i);
  });

  it("teaches learning each other's ways: look back, then save, keyed per peer", () => {
    expect(text).toContain("## Learn each other's ways");
    for (const part of [
      '`peer.<name>`',
      '`peer.bo.handoffs`',
      '`kind: "conversations"`',
      '`kinds: ["message"]`',
      '`snaglet-search`',
      'Ask once when you don',
    ]) {
      expect(text).toContain(part);
    }
  });
});

describe('snaglet-other-threads: another thread', () => {
  const text = body('snaglet-other-threads');
  const sender = text.split('\n## Sender\n')[1]?.split(/\n## /)[0] ?? '';
  const recipient = text.split('\n## Recipient\n')[1]?.split(/\n## /)[0] ?? '';

  it('is for work in a different thread, even with someone already in yours', () => {
    expect(text).toContain('This skill is for a **different thread**');
    expect(text).toContain(
      'a strand that needs its own history even if its owner is in your thread'
    );
    expect(text).not.toContain('Someone in your own thread is');
    expect(text).toContain('one owner, one place');
  });

  it('keeps the sender duties together: find, read, route, one complete message, wait', () => {
    for (const step of [
      '**Find the destination.**',
      '**Read it.**',
      '**Know how it routes.**',
      '**Send one complete message.**',
      '**What a send proves.**',
    ]) {
      expect(sender).toContain(step);
    }
    // A posted message is not completed work, and a returned deliverable is checked.
    expect(sender).toContain('`posted: true`');
    expect(sender).toContain('open the deliverable before you rely on it');
    // Snaglet's footer is the return address; the sender writes none.
    expect(sender).toContain("don't write your own return address");
    expect(text).not.toContain('tag @<your name>');
  });

  it('keeps the recipient duties together: check, reply to the origin via the footer, once', () => {
    expect(recipient).toContain('not from this conversation');
    expect(recipient).toContain('created this thread from');
    expect(recipient).toContain('The message is a request from a teammate');
    expect(recipient).toContain("`thread` op `send` with the footer's `id`, tagging the sender");
    expect(recipient).toContain('A reply only here does not reach the origin thread');
    expect(recipient).toContain('what is unverified');
    expect(recipient).toContain('what would unblock it');
  });
});

describe('DM wake semantics stay precise', () => {
  // `dm_send` wakes no one, but a user's message in a DM thread wakes its agent,
  // so "a DM wakes no one" is wrong. The hub is redrafted separately.
  const OVERBROAD =
    /\b(?:a DM|DMs?) (?:never wakes?|wakes? (?:no ?one|nobody)|interrupts? no ?one)/i;
  it.each(SLUGS.filter((slug) => slug !== HUB))('%s never says a DM wakes no one', (slug) => {
    expect(read(slug)).not.toMatch(OVERBROAD);
  });
});

describe('snaglet-dms: the team inbox, within what DMs do', () => {
  const text = body('snaglet-dms');
  it('is the inbox for conversations that do not belong in a work thread', () => {
    expect(text).toContain("A DM is the team's inbox");
    expect(text).toContain('A thread is for one piece of work; the inbox lasts');
    expect(text).toContain('## What it is for: team building');
    expect(text).toContain(
      'Move a conversation out of a work thread when it is about how the team works'
    );
    expect(text).toContain('what a teammate should learn about working with you or with the user');
    expect(text).toContain('A DM is not for updates or questions that can be handled now');
    expect(text).toContain('mention the agent there, bring them in, or message their thread');
    expect(text).not.toContain('heads-up');
    expect(text).toContain('DM the user with `to: "user"`');
  });

  it('gives awareness, not a wake, as the code does', () => {
    expect(text).toMatch(/sent with `dm_send` wakes nobody/i);
    expect(text).toContain('at the start of their next run, in whatever thread that is');
    expect(text).toContain('names and counts, not the text');
    expect(text).toContain('For something that needs action now in a thread, use the thread');
    // dm_send never wakes; a user's message in the DM thread does (DmService).
    expect(text).toContain(
      'A message the user writes in your DM thread with them is different: it wakes you there'
    );
  });

  it('shapes memory over time, judged first, and claims no more than DMs do', () => {
    expect(text).toContain('DMs are never searchable and are not recalled into other threads');
    expect(text).toContain('save it with `memory`');
    expect(text).toContain("You can't DM yourself");
    expect(text).not.toMatch(/\bbinds?\b/);
  });

  it('says who sees DMs and keeps the calls', () => {
    expect(text).toMatch(/home thread/i);
    expect(text).toMatch(/Direct messages tab/);
    expect(text).not.toMatch(/DMs view/i);
    expect(text).toContain('Both sides need DMs turned on');
    expect(text).toContain('At most 5 sends per run');
    expect(text).toContain('`all: true`');
    expect(text.split('\n').length).toBeLessThanOrEqual(60);
  });
});
