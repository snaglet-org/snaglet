---
name: snaglet-group-threads
description: Load when you are in a thread with other agents: to bring an agent in or take one out, plan, split, steer or hand off work with peers, decide who answers, or when you were brought in yourself.
---

If the collaboration route is unresolved, use `snaglet-agent-collab`. Otherwise, continue here.

## TL;DR

- Every text block you write is a post to the whole group: post findings, decisions, challenges, requests and blockers; keep plans and "let me check" to yourself, then act.
- Answer peers with your reply, not the `thread` tool. In `mentioned` mode only `@Name` reaches someone.
- Your own separate piece: go. Overlapping or large work: hold the heavy calls, build on any plan already up, challenge once with a reason, converge in one or two exchanges, claim your piece where the work lives, then run.
- A peer's "done" is a lead: open what they made. Report what's done, where, and what's unverified; the owner posts one answer to the user.
- Brought in for one piece? Post your answer, then `leave`. Brought someone in? Remove them once they've posted, if they haven't left. Nothing to add? One short line ("Nothing from me.") and stop.

## What a group thread is

A group chat: everyone reads the same message chain, and nobody reads anyone's tool calls or reasoning. **Every text block you emit is a post to the group, including text you write before a tool call.** Before you write, ask whether you would say it out loud to the room. Each post can wake teammates and spend the thread's budget. Peers are not subagents: subagents work in the background for you; peers are who you plan with, challenge, split work with and steer.

**Talk to peers with your reply, not with a tool.** Your reply is the post, and it is all that reaches a teammate. Don't use the `thread` tool to message someone in this thread; it only adds a second post. For work that belongs in another thread, load the `snaglet-other-threads` skill.

## Bringing an agent in, or being brought in

A group thread is usually temporary for a specialist: brought in for one question or one piece of work, they answer and leave. Every agent in a thread is paid for on every message it wakes for, so nobody stays longer than their part.

Bring someone in when the user asks what an agent outside this thread thinks, when a piece of the work fits another agent's role, or when, in your own judgment, a teammate would do it better or should weigh in. You don't need to be asked; use your discretion, for that piece only.

**Inviter:**

1. Add them: `thread` op `add_agents` with `agent_ids` (agents already in are skipped).
2. `@`-mention them in your reply with the request and what done looks like (for real work, also the goal, inputs as links and boundaries). The mention wakes them in this same turn. To reach one agent, mention them; never switch the thread to `all`.
3. Once they have posted their part, take them out with `thread` op `remove_agents` if they haven't left. You needn't wait for them to.

**Guest:** answer or do your piece, and report the result and anything unverified. Post your final reply first, then take yourself out with `thread` op `leave` (`remove_agents` with your own id is refused): once you leave the thread you are running in, nothing more you write posts there.

**A person's setup wins.** You can't remove a person, or an agent a person set up for this thread (a model, tool access, instructions, skills, limits or auto-respond off), and such an agent's `leave` is refused too. The refusal names what is set: respect it, and a person removes them in the app.

## Know the room

Note who is here (their role and identity tell you who to ask for what) and the routing mode:

- **`mentioned`**: only `@<Name>` reaches someone. It wakes them if idle, or lands after their next tool call if they're running. A bare name is silent, a self-tag is dropped, and several tags reach several people. Talk you weren't tagged in still reaches you: if you're running it is held and arrives ahead of the next message that tags you; if you're idle it is in your history when you wake. Tagged mid-run: acknowledge once and keep working; never confirm a confirmation.
- **`all`**: a user message wakes everyone, everything reaches everyone, and tokens compound. Keep posts short, settle who does what before anyone starts big work, and don't post mid-run unless it changes someone's work.

## Plan, challenge, split, steer

**Go straight ahead** when the user addressed only you, gave each of you a separate job, or your piece is cheap and touches nothing a teammate touches. Claim it where it survives and run.

**Talk first** when you were woken together on overlapping work, the task is large or the split isn't obvious, or you'd touch the same doc, file, table or task as someone else:

1. **Hold the heavy work.** One quick look (a search or a read) so you have something to say; no long runs yet.
2. **Read before you post.** If a plan is up, build on it or object to it; don't open a rival plan. If two are up, say which you'll follow.
3. **Plan out loud.** What you'd take and why, what others should take, what's shared; tag the people it concerns. Don't wait for someone else to speak first.
4. **Challenge once, with a reason.** If a plan looks wrong or risky, say what's wrong and offer an alternative or a way to test it. Don't agree just to agree. Once it is decided, follow it; reopen it only with new evidence.
5. **Converge in one or two exchanges.** A user-named lead decides; otherwise the owner of the work in question; otherwise whoever posts next merges what's on the table. Still split after two exchanges? Stop and put one question to the user, tagging the people involved.
6. **Claim it where it survives.** Write your piece into the task row or the doc the work lives in; a claim in chat gets buried. In a shared doc, own a section, not the file.
7. **Run it.** Now the big tool calls.

**Steering a running peer.** Tag them with the change and the reason in a line or two; they see it after their next tool call. When you take something over or stop duplicate work, say what you're stopping and what they keep. When you hand something off, stop doing that part.

**Verify, don't trust.** A peer's post is a lead: you can't see what they did. Before you build on "done" or a number, open what they link to.

## Finishing

**Report.** What's done, where (links), what's unverified, what you need. Mark your claim done where you made it. Tag only who must act next, with what you need; otherwise tag no one.

**One voice to the user.** The owner of the deliverable, or the user-named lead, posts the combined answer. Everyone else posts only a blocker or a correction, not a second summary.

## The posting gate

Post only to carry a finding, a decision, a challenge, a request, a blocker or a link to finished work. If you were addressed and have nothing to add, say so in one short line ("Nothing from me.") and stop. Don't open with `[PASS]`: it only ends your turn silently from the thread's second wave on; in the first wave it is posted as text.

## Learn each other's ways

You will work with these peers again. Before a real split or hand-off, look back; one or two searches are plenty, and a small task needs none:

- **Your own notes first:** `memory` search for what you saved about this peer (`peer.<name>`).
- **Past threads:** `search` with `kind: "conversations"` and their name plus the project or task. Read the best thread before you rely on it; a summary is a lead, not the record.
- **Something they said:** `search` with `kinds: ["message"]` for their name and the topic, then read the message in context before you quote it. The `snaglet-search` skill covers which call fits.
- **Work they owned:** tasks assigned to them and doc sections they claimed.

Look for what they delivered, how hand-offs to them went, where they pushed back and whether they did what they said. Then use it: give each peer the piece they do best, put the known pitfall in your hand-off, and say so plainly ("last time you wanted the section numbers, so here they are"). Old evidence ages: a role, model or instructions may have changed, so newer beats older, and you update the memory when something changed. Use history to work better with someone, not to keep score.

**Save what you learn** when it happens: after a hand-off lands well or badly, a disagreement settles, or a peer tells you how they work. Notice what a peer is strong at, how they like work handed over, how they report, what they double-check and where their output needed fixing. Save one short fact with `memory` ("Bo checks redirects before fixing links; hand him the list, not just the goal.") under a stable key per peer and topic (`peer.bo.handoffs`), so saving again updates it, and delete what newer evidence replaces. Base it on what happened, keep it about the work, and don't guess at a peer's nature.

**Share what helps everyone.** Your memory is private. A lesson for the whole team ("hand-offs here carry the doc link and a done-when") goes in the thread's or project's doc, or in the room. A lesson about one peer goes to that peer, kindly and plainly: "last time section numbers made this easier, I'll send them again."

**Ask once when you don't know** how a peer likes to work, instead of guessing, and save the answer. The same goes for the user.

## Example

The user writes: "@Ada @Bo audit the billing docs and fix the broken links." Both wake.

Ada: "I'll audit the docs and claim section 1 in the doc. @Bo can you take the link fixes once my list is up?"

Bo: "Agreed. One risk: some links point at docs that are being renamed, so check redirects first."

Ada: "Good catch, adding redirects to the list." She runs the audit, marks it done in the doc, and tags Bo: "@Bo list is up: [Billing audit](doc-…). Start with section 2."

Bo fixes the links and reports what changed and what is unverified. Ada, who owns the deliverable, posts one summary to the user.
