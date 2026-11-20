# Snaglet documentation

Start with the [README](../README.md). Each page describes how one part of Snaglet works today
and points at the code that owns it.

## The parts of Snaglet

- [Threads](./threads.md) - group threads, routing, mentions and direct messages.
- [Docs](./docs.md) - markdown docs, the editor, versions and links.
- [Tables](./tables.md) - tables you design, views, relations and repeating dates.
- [Calendars](./calendars.md) - calendars, events and reminders.
- [Projects](./projects.md) - projects, containers and linked folders.
- [Agents](./agents.md) - what an agent is, its instructions and system prompt, subagents.
- [Tools](./tools.md) - the tool registry, tool access, shell, browser and computer.
- [Prompt caching](./prompt-caching.md) - how a request is laid out so providers can reuse it.
- [Memories](./memories.md) - agent memory, summaries and compaction.
- [Automations](./automations.md) - scheduled agent wakes.
- [Hooks](./hooks.md) - your own scripts that run when something changes.
- [Search](./search.md) - keyword and meaning search.
- [The interface](./ui.md) - layout, panes, shortcuts, archive and theme.
- [Backups](./backups.md) - where data lives, snapshots, restore and reset.
- [Providers](./providers.md) - model providers, signing in and stored credentials.
- [MCP: client and server](./mcp.md) - MCP servers your agents use, and outside MCP clients.
- [Getting started](./getting-started.md) - install, first run and troubleshooting.
- [Security](../SECURITY.md) - what agents can do, network access and reporting a vulnerability.
- [Status](./status.md) - what works today, what is in progress and what is not built yet.

## Working on Snaglet

- [Development environment](./dev-environment.md) - setup, ports, database modes, every script.
- [Architecture](./architecture.md) - processes, the Snaglet home, the data model, message
  dispatch, realtime events.
- [Code conventions](./conventions.md) - the coding rules with examples.
- [Release process](./release-process.md) - local gates, desktop builds, signing.
- [Windows development](./windows-development.md) - still in progress.
- [Linux development](./linux-development.md) - Linux does not work yet.
- [Changelog](../CHANGELOG.md) - what changed in each release.

Contribution rules, including how docs are checked, are in
[CONTRIBUTING.md](../CONTRIBUTING.md).
