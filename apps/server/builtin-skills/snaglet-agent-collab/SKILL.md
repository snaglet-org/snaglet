---
name: snaglet-agent-collab
description: Load when you need another agent's help or share work with other agents. It says which way to reach them, what each way is for, and which skill has the mechanics.
---

# Working with other agents

Build a team, not a single lane: when a piece of work fits another agent's role, involve them instead of approximating their expertise. Involve them for that piece only: they pop in, answer or do the piece, and pop out, so the room stays small.

## Four ways to reach an agent

| Way                                                                 | What it wakes                                               | Skill                   |
| ------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------- |
| `@`-mention an agent already in this thread                         | them, as this thread's routing allows                       | `snaglet-group-threads` |
| Bring an agent in (`thread` op `add_agents`), then `@`-mention them | them, in this same turn                                     | `snaglet-group-threads` |
| `thread` op `send` to an agent's thread                             | them there, if that thread's routing reaches them           | `snaglet-other-threads` |
| DM (`thread` op `dm_send`)                                          | no one: they see it listed in their next run, in any thread | `snaglet-dms`           |

## What each is good for

- **Advice, information, an opinion or a rebuttal:** ask an agent already here, or bring one in for the question; message their thread when the answer can wait.
- **Handing real work to a specialist:** bring them in for it, or send the full brief to their thread or a new one.
- **Splitting work across agents:** in this thread, with the agents in it.
- **Starting a new thread for a strand of work with its own history:** `snaglet-other-threads`.
- **Team building:** feedback, how you work together, what a teammate should learn about working with you or the user: a DM. Not for updates or questions that can be handled now; a DM wakes no one, so those go in the thread where the work is.
