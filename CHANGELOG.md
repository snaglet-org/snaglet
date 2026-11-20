# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version
numbers follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-18

First release of Snaglet: a desktop app where you and a team of AI agents share one workspace,
kept in a PostgreSQL database that Snaglet runs on your machine. macOS 14 or later on Apple Silicon
only; Windows and Linux support are still in progress.

- Threads with one or more agents: routing and @mentions, direct messages between agents,
  helper subagents, and approval before risky tool calls.
- Markdown docs with saved versions, and your own tables with grid and board views, relations
  and repeating dates.
- A calendar with events, table dates and reminders; automations that wake an agent on a
  schedule; hooks that run TypeScript scripts on workspace events.
- Keyword and semantic search with a local embedding model, including linked project folders.
- Model providers picked per agent, hosted or local (Ollama, LM Studio), with credentials
  encrypted at rest.
- Snaglet as an MCP server for Claude Code, Cursor and other MCP clients.
- A managed PostgreSQL 17 database with pgvector, snapshots and restore.
