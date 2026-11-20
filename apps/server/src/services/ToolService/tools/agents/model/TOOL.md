# model

LLM providers and their models; the verb is `op`.

## op: list

List configured providers with `operation: "providers"`, or a provider's live
chat-model catalog with `operation: "models"` and `provider_id`.

## op: add

Add a custom chat model, with its metadata, to an LLM provider. This does the
same as "add custom model" in the Providers UI (`POST /api/models`).

- `provider_id` and `model_id` are required. Use op `list` to find provider
  ids and the live catalog.
- `metadata` takes only the per-model tuning keys: `safetyMarginPct` (0–90),
  `cacheTtl` (`5m` | `1h`), `contextCompression` {`tokenBudgetRatio`,
  `tailMessages`}, and `summary` {`maxWords`, `tokenThreshold`: estimated tokens of new conversation that make the
  thread digest due, default 20,000}.
- If the model already exists on the provider, it is updated: fields you leave
  out keep their values, metadata you pass replaces the old metadata, and a
  model the user removed is restored.
- Built-in local (runtime) and integration providers are rejected.

Old tool names still work: `list_models` → list, `add_model` → add,
`get_providers` / `get_provider_models` → list with that `operation`.
