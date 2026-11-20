# Generate Chart

Create a simple SVG chart from labeled numeric data. Returns SVG markup or writes it to outputPath.

**Tier:** standard
**Type:** builtin

## Parameters

| Name         | Type                                                       | Required | Description                                                                       |
| ------------ | ---------------------------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| `data`       | object                                                     | Yes      | Chart data: { labels: string[], datasets: [{ label: string, values: number[] }] } |
| `type`       | enum("bar", "line", "pie", "scatter", "area", "histogram") | Yes      | Chart type                                                                        |
| `title`      | string                                                     | No       | Chart title                                                                       |
| `options`    | object                                                     | No       | Additional chart options (colors, axes labels, legend position, etc.)             |
| `outputPath` | string                                                     | No       | Optional file path to save the generated SVG                                      |

## Example Input

```json
{
  "type": "bar",
  "data": {}
}
```

## Notes

- Validate inputs against `definition.ts` before changing handler behavior so docs, runtime, and DB metadata stay in sync.
- Use absolute paths for filesystem-oriented parameters unless the handler explicitly documents relative-path support.
