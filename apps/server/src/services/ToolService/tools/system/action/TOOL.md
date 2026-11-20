# Action

Execute any available tool. Pass a tool ID (snake_case) or display name, plus its parameters.

**Tier:** core
**Type:** builtin

## Parameters

| Name     | Type   | Required | Description                                                         |
| -------- | ------ | -------- | ------------------------------------------------------------------- |
| `tool`   | string | Yes      | The tool to execute by ID or display name (e.g. `file` or `"File"`) |
| `params` | object | No       | Parameters for the tool                                             |

## Example Input

```json
{
  "tool": "File Read",
  "params": {
    "path": "/tmp/example.txt"
  }
}
```

## Notes

- Validate inputs against `definition.ts` before changing handler behavior so docs, runtime, and DB metadata stay in sync.
