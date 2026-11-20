---
name: snaglet-projects
description: Load when a body of work or context needs an organized focus, or before you create or reorganize a project or its containers, link its folder or git repo, turn on search over its files, or decide where its tasks live; not for ordinary work inside an existing project.
---

# Projects: an organized focus for a body of work

A project gives a body of work or context an organized focus: its own docs, threads and tables, and optionally a linked folder on disk, so agents working on it stay in scope and look there first.

## When to create one

Create a project when the work is a body of its own: it will have several threads, tables, docs or tasks over time, or it is a code folder the team will keep working in. Don't make one for a single question, one doc or a one-off job; put those in the current project, or workspace-wide.

First search for an existing project on the same work: two projects for one thing split its threads, tables and memories. Name a new one for the work, not for you or a date, and create it with `container` (`op: create`, `category: "project"`), adding `folder_path` and `github_url` if you know them.

## Organize its containers

Inside a project, a container groups docs, images and other containers. Make one when a set of docs belongs together and will grow (a spec and its notes, a research strand); keep nesting shallow so things stay findable. Threads and tables attach to the project itself, never to a container inside it. Create a container with `container` op `create` (`parent_id` or `parent_path`), and move, rename or archive one with `node`.

## Tasks and tables

A task doesn't have to be a table row, but rows are an efficient way to query and track long-term tasks: keep those in the project's task table. Create a new table only when no project table fits, and say why in your reply.

## Link a folder or repo

Use `container` (`op: update`) with `folder_path` (an absolute local path) and/or `github_url`; `null` or `""` clears one.

- Look at the folder first (`file` list) and link the project's own root, not a parent of many repositories.
- A folder with more than 500 eligible files is refused until a person confirms it in the project's folder settings. Tell them which folder and why; don't retry the call.
- Everything else only warns and still links: no repo marker (`.git`, `package.json`, and so on), a folder of several repositories, or a folder that contains another project's folder. Read `folder_warnings` in the result and tell the person about any that look like a mistake.
- Changing a linked folder re-points the index: files at the same paths keep their embeddings, files gone from the new tree are dropped, and a large drop is held for a person to approve.
- If the call says indexing is busy, try again later.

## Search over the folder's files

Read `file-search.md` in this skill (`skill` op `read`, `slug: "snaglet-projects"`, `path: "file-search.md"`) only if the project links a folder with many files, such as a large markdown collection or a codebase, and the person wants them searchable.
