import { writeFile } from 'fs/promises';
import { asNonEmptyString, escapeXml, requireString } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { validatePathConstraint } from '@server/services/ToolService/handlers/_shared';

type ChartKind = 'bar' | 'line' | 'pie' | 'scatter' | 'area' | 'histogram';

interface ChartDataset {
  label: string;
  values: number[];
}

interface ChartInput {
  labels: string[];
  datasets: ChartDataset[];
}

function ensureChartInput(input: unknown): ChartInput {
  if (!input || typeof input !== 'object') {
    throw new Error('data must be an object');
  }

  const record = input as Record<string, unknown>;
  const labels = Array.isArray(record.labels)
    ? record.labels.filter((value): value is string => typeof value === 'string')
    : [];
  const datasets = Array.isArray(record.datasets)
    ? record.datasets
        .filter(
          (value): value is Record<string, unknown> => typeof value === 'object' && value !== null
        )
        .map((dataset, index) => ({
          label:
            (typeof dataset.label === 'string' && dataset.label.trim()) || `Series ${index + 1}`,
          values: Array.isArray(dataset.values)
            ? dataset.values.map((value) => Number(value)).filter((value) => Number.isFinite(value))
            : [],
        }))
        .filter((dataset) => dataset.values.length > 0)
    : [];

  if (labels.length === 0) {
    throw new Error('data.labels must contain at least one label');
  }
  if (datasets.length === 0) {
    throw new Error('data.datasets must contain at least one dataset');
  }

  for (const dataset of datasets) {
    if (dataset.values.length !== labels.length) {
      throw new Error('Each dataset.values array must match data.labels length');
    }
  }

  return { labels, datasets };
}

function palette(index: number): string {
  const colors = ['#0f766e', '#2563eb', '#dc2626', '#ea580c', '#7c3aed', '#0891b2'];
  return colors[index % colors.length];
}

function maxValue(data: ChartInput): number {
  return Math.max(
    1,
    ...data.datasets.flatMap((dataset) => dataset.values.map((value) => Math.max(0, value)))
  );
}

function pointSeries(data: ChartInput, width: number, height: number) {
  const left = 60;
  const top = 60;
  const innerWidth = width - 100;
  const innerHeight = height - 120;
  const max = maxValue(data);
  const stepX = data.labels.length > 1 ? innerWidth / (data.labels.length - 1) : innerWidth / 2;

  return {
    left,
    top,
    innerWidth,
    innerHeight,
    max,
    points(dataset: ChartDataset) {
      return dataset.values.map((value, index) => {
        const x = left + (data.labels.length > 1 ? stepX * index : innerWidth / 2);
        const y = top + innerHeight - (Math.max(0, value) / max) * innerHeight;
        return { x, y, value };
      });
    },
  };
}

function renderAxes(data: ChartInput, width: number, height: number): string[] {
  const left = 60;
  const top = 60;
  const innerWidth = width - 100;
  const innerHeight = height - 120;

  return [
    `<line x1="${left}" y1="${top}" x2="${left}" y2="${top + innerHeight}" stroke="#64748b" stroke-width="1" />`,
    `<line x1="${left}" y1="${top + innerHeight}" x2="${left + innerWidth}" y2="${top + innerHeight}" stroke="#64748b" stroke-width="1" />`,
    ...data.labels.map((label, index) => {
      const x =
        data.labels.length > 1
          ? left + (innerWidth / Math.max(data.labels.length - 1, 1)) * index
          : left + innerWidth / 2;
      return `<text x="${x}" y="${top + innerHeight + 24}" font-size="12" text-anchor="middle" fill="#334155">${escapeXml(label)}</text>`;
    }),
  ];
}

function renderBarChart(data: ChartInput, width: number, height: number): string[] {
  const left = 60;
  const top = 60;
  const innerWidth = width - 100;
  const innerHeight = height - 120;
  const max = maxValue(data);
  const groupWidth = innerWidth / data.labels.length;
  const barWidth = (groupWidth * 0.7) / data.datasets.length;

  const bars = data.datasets.flatMap((dataset, datasetIndex) =>
    dataset.values.map((value, index) => {
      const x = left + groupWidth * index + groupWidth * 0.15 + barWidth * datasetIndex;
      const barHeight = (Math.max(0, value) / max) * innerHeight;
      const y = top + innerHeight - barHeight;
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${palette(datasetIndex)}" rx="3" />`;
    })
  );

  return [...renderAxes(data, width, height), ...bars];
}

function renderLineFamily(
  data: ChartInput,
  width: number,
  height: number,
  fillArea: boolean
): string[] {
  const helpers = pointSeries(data, width, height);

  return [
    ...renderAxes(data, width, height),
    ...data.datasets.flatMap((dataset, datasetIndex) => {
      const points = helpers.points(dataset);
      const polyline = points.map((point) => `${point.x},${point.y}`).join(' ');
      const elements = [
        fillArea
          ? `<polygon points="${helpers.left},${helpers.top + helpers.innerHeight} ${polyline} ${helpers.left + helpers.innerWidth},${helpers.top + helpers.innerHeight}" fill="${palette(datasetIndex)}22" stroke="none" />`
          : null,
        `<polyline points="${polyline}" fill="none" stroke="${palette(datasetIndex)}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" />`,
        ...points.map(
          (point) =>
            `<circle cx="${point.x}" cy="${point.y}" r="4" fill="${palette(datasetIndex)}" />`
        ),
      ].filter(Boolean) as string[];

      return elements;
    }),
  ];
}

function renderScatterChart(data: ChartInput, width: number, height: number): string[] {
  const helpers = pointSeries(data, width, height);

  return [
    ...renderAxes(data, width, height),
    ...data.datasets.flatMap((dataset, datasetIndex) =>
      helpers
        .points(dataset)
        .map(
          (point) =>
            `<circle cx="${point.x}" cy="${point.y}" r="6" fill="${palette(datasetIndex)}" opacity="0.8" />`
        )
    ),
  ];
}

function polarToCartesian(cx: number, cy: number, radius: number, angle: number) {
  const radians = ((angle - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  };
}

function describeArc(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number
): string {
  const start = polarToCartesian(cx, cy, radius, endAngle);
  const end = polarToCartesian(cx, cy, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x} ${end.y} Z`;
}

function renderPieChart(data: ChartInput, width: number, height: number): string[] {
  const dataset = data.datasets[0];
  const total = dataset.values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) {
    throw new Error('Pie charts require at least one positive value');
  }

  const cx = width / 2;
  const cy = height / 2 + 10;
  const radius = Math.min(width, height) * 0.28;
  let angle = 0;

  return dataset.values.flatMap((value, index) => {
    const safeValue = Math.max(0, value);
    const nextAngle = angle + (safeValue / total) * 360;
    const labelAngle = angle + (nextAngle - angle) / 2;
    const labelPoint = polarToCartesian(cx, cy, radius + 28, labelAngle);
    const elements = [
      `<path d="${describeArc(cx, cy, radius, angle, nextAngle)}" fill="${palette(index)}" />`,
      `<text x="${labelPoint.x}" y="${labelPoint.y}" font-size="12" text-anchor="middle" fill="#0f172a">${escapeXml(data.labels[index])}</text>`,
    ];
    angle = nextAngle;
    return elements;
  });
}

function buildChartSvg(kind: ChartKind, data: ChartInput, title: string | null): string {
  const width = 840;
  const height = 520;
  const body =
    kind === 'pie'
      ? renderPieChart(data, width, height)
      : kind === 'line'
        ? renderLineFamily(data, width, height, false)
        : kind === 'area'
          ? renderLineFamily(data, width, height, true)
          : kind === 'scatter'
            ? renderScatterChart(data, width, height)
            : renderBarChart(data, width, height);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title ?? 'Chart')}">`,
    '<rect width="100%" height="100%" fill="#f8fafc" />',
    title
      ? `<text x="60" y="34" font-size="24" font-weight="700" fill="#0f172a">${escapeXml(title)}</text>`
      : null,
    ...body,
    '</svg>',
  ]
    .filter(Boolean)
    .join('\n');
}

const tool: ToolHandler = async (input, settings) => {
  const rawType = requireString(input, 'type') as ChartKind | 'heatmap';
  const type = rawType === 'histogram' ? 'bar' : rawType;
  if (!['bar', 'line', 'pie', 'scatter', 'area'].includes(type)) {
    throw new Error(`Unsupported chart type: ${rawType}`);
  }

  const data = ensureChartInput(input.data);
  const title = asNonEmptyString(input.title) ?? null;
  const outputPath = asNonEmptyString(input.outputPath);
  const svg = buildChartSvg(type as ChartKind, data, title);

  if (outputPath) {
    validatePathConstraint(outputPath, settings);
    await writeFile(outputPath, svg, 'utf8');
    return `Chart SVG saved to ${outputPath}`;
  }

  return svg;
};

export default tool;
