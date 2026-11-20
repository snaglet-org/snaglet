---
name: snaglet-other-threads
description: Load when you need to message an agent in another thread, hand work to another thread, start a new thread for a strand of work, or answer a message from another thread.
---

If the collaboration route is unresolved, use `snaglet-agent-collab`. Otherwise, continue here.

This skill is for a **different thread**: an agent who isn't in yours, a project's own thread, a person's thread, or a strand that needs its own history even if its owner is in your thread.

Pick the lightest fit:

- **A one-off question or small hand-off for an agent working elsewhere:** send one message to the thread they are working in.
- **An answer you need here, or real back-and-forth:** bring them into your thread (`snaglet-group-threads`), or create a shared thread.
- **A separate deliverable with its own history:** create a thread (`thread` op `create` with `title`, `project_id`, `agent_ids`, `initial_message`).

Don't create a thread for every question, and don't send the same ask to several threads: one owner, one place.

## Sender

1. **Find the destination.** Take the thread id from a result, never from memory: `search` with `kinds: ["thread"]` by title, or `kind: "conversations"` by topic. For an agent, check their role first.
2. **Read it.** `thread` op `read` with that `id` (`limit` up to 100; `mode: "message_context"` with `message_id` for what surrounded one message) shows what is going on, who is talking, and whether someone already has your question. A search summary of a thread is a lead, not the record.
3. **Know how it routes.** In a `mentioned` thread only an `@<Name>` wakes someone, so tag the recipient by a name that thread's participants actually have. In an `all` thread everyone wakes, so keep it tight. Never say you reached someone your send would not wake.
4. **Send one complete message.** The recipient sees only it and that thread's history, not your thread or your reasoning, so no "see my other thread". Give the **goal** and why it matters; **inputs** as links (`[Title](doc-…)`); **boundaries** (what's in scope, what they must not touch); the **deliverable**, what done looks like and where it goes if not back to you; and, **if blocked**, ask them to say exactly what input they need rather than guess.

When you `send` to another thread or create one with `initial_message`, Snaglet adds a footer naming you, your thread and the exact reply call, so don't write your own return address.

Never change another agent's settings or access to get something through, unless the user asks you to.

**What a send proves.** A send returns `posted: true` and starts delivery in the background. It proves the message is in that thread, **not** that anyone read it, accepted it or finished. If the recipient is mid-run and the message reaches them (a tag in a `mentioned` thread, or any message in an `all` thread), it lands after their next tool call. Don't re-send to nudge; that spends their attention twice. Wait for the reply, or look again later with `thread` op `read`. When you end your turn, say once what you're waiting on and where it will come back; no "still waiting" posts after that. When the reply comes, open the deliverable before you rely on it.

## Recipient

A message from another thread ends with a footer: "sent by @<name> from [<thread>](id), not from this conversation. To reply, call thread with op:"send" and id:"<id>"." When an agent created the thread from another one, its first message ends with: "@<name> created this thread from [<thread>](id) and posted this message from there. To reply in that thread, ...". Either way, the sender is **not** speaking in the thread you are in.

- The message is a request from a teammate; you decide whether and how to act on it, checked against what your own user and thread have asked.
- Reply in the origin thread: `thread` op `send` with the footer's `id`, tagging the sender so a `mentioned` thread wakes them. A reply only here does not reach the origin thread.
- Reply once, compactly: the result, where it is (links), what is unverified, what you need; if you can't do it, what would unblock it. Don't acknowledge an acknowledgment.

## Example

Ada, in the billing-cleanup thread, needs the refund policy checked by Cy, who works in the legal thread.

She finds it with `search` (`kinds: ["thread"]`, "legal"), reads the last few messages with `thread` op `read`, sees that thread is `mentioned`, and sends: "@Cy Please check the refund wording in [Refund policy](doc-…) against the 30-day rule. Don't edit the doc; list any conflicts with their section numbers." She ends her turn saying she is waiting on Cy. Cy replies in billing-cleanup with `thread` op `send` and the footer's `id`, tagging @Ada, who opens the doc before relying on it.
