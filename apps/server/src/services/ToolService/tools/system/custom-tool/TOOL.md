# custom_tool

One tool, `op` = `create | update`. `create_tool` is an op-pinned alias of `create`.

- `create` (`name`, `description`, optional `parameters_schema`, `handler_source`): scaffolds a new tool; an existing name is rejected.
- `update` (`name` + at least one of `description`, `parameters_schema`, `handler_source`): changes an existing custom tool and keeps whatever you omit. The folder is swapped atomically and re-registered immediately; a compile failure is returned and the tool is left disabled until a fixing update. `definition.json` is rewritten with the default category, tier and keywords. Never creates: an unknown name is an error.

Both `create` and `update` write Node code that is built and run as the user, so a guarded agent is asked to confirm before either op runs. A trusted / "all tools" agent skips that prompt.

To find or inspect tools (including their schemas) use `tool`.

`create` creates `<snaglet-home>/tools/<name>/definition.json` and `tool.ts` atomically. The existing custom-tool folder scanner owns building and registration; this tool only waits until that registration is visible before returning.

`handler_source`, when supplied, is the complete contents of `tool.ts` and must default-export a handler. Without it, the generated handler is a compiling no-op.

## What you are writing

`tool.ts` is bundled with esbuild against a vendored `@snaglet/sdk` (no install step) and executed in a **forked child process**.

```ts
import snaglet from '@snaglet/sdk';

export default async function handler(
  input: Record<string, unknown>,
  context: { agentId?: string; threadId?: string; triggerMessageId?: string }
) {
  return { ok: true };
}
```

Rules:

- The default export must be the handler, or the build fails.
- Validate `input` defensively — it arrives from a model, not from a typed caller.
- Return something JSON-serializable; throw to fail the call.
- Import only from `@snaglet/sdk` and `node:*`. Third-party packages need an install step that is not part of the build.
- `snaglet.tools.execute(name, input)` resolves to `{ success, output, error?, durationMs }`, where `output` is a plain string. Tool ids are snake_case and parameter names are exact. Also available: `snaglet.log.info|warn|error`, `snaglet.context.get()`, `snaglet.parseContent(nodeId)`.

⚠️ The built-in tools under `apps/server/src/services/ToolService/tools/**` are useful prior art for _logic_, but they use a **different, in-process handler signature** and import server modules directly. Copy their approach, never their imports — a custom tool that imports server internals will not build.

## definition.json

Written for you from the tool's parameters, and the shape the scanner reads:

```json
{
  "name": "export-report",
  "description": "Agent-facing description of what the tool does.",
  "categoryPath": "custom",
  "providerId": null,
  "tier": "standard",
  "parametersSchema": { "type": "object", "properties": {}, "required": [] },
  "keywords": []
}
```

`parametersSchema` must be a JSON Schema object describing exactly the fields the handler reads from `input`. Property types in practice: `string`, `number`, `boolean`, `array` (with `items`), or `string` with an `enum`.
