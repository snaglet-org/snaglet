import type { ToolRow } from '@desktop/utils/api';

export interface ToolGroup {
  key: string;
  label: string;
  tools: ToolRow[];
  children: ToolGroup[];
}

export interface ToolSection {
  key: string;
  label: string;
  tools: ToolRow[];
  groups: ToolGroup[];
}

// Tools are grouped strictly by their folder-derived `category_path` (e.g.
// 'docs', 'code', 'integrations/google'). The first path segment is a top-level
// section; deeper segments nest as groups. Labels title-case the segment, with a
// few overrides for names that shouldn't just be capitalized.
const LABEL_OVERRIDES: Record<string, string> = {
  integrations: 'Integrations',
  github: 'GitHub',
  google: 'Google',
  apple: 'Apple',
  custom: 'Custom Tools',
  uncategorized: 'Other',
  // notion/postgres are MCP servers, not builtin tools, and browsing is the
  // native `browser` tool, so none of them need a label here.
};

function labelFor(segment: string): string {
  return (
    LABEL_OVERRIDES[segment] ??
    segment
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  );
}

function segmentsFor(tool: ToolRow): string[] {
  const segs = (tool.categoryPath || 'uncategorized').split('/').filter(Boolean);
  return segs.length > 0 ? segs : ['uncategorized'];
}

function sortTools(a: ToolRow, b: ToolRow): number {
  return Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name);
}

interface MutableGroup {
  key: string;
  label: string;
  tools: ToolRow[];
  childMap: Map<string, MutableGroup>;
}

interface MutableSection {
  key: string;
  label: string;
  tools: ToolRow[];
  groupMap: Map<string, MutableGroup>;
}

/**
 * Group tools into the category tree their `category_path` describes. First
 * segment → section; remaining segments → nested groups. A single-segment
 * category (e.g. 'docs') becomes a section whose tools render directly; a
 * multi-segment one (e.g. 'integrations/google') nests under its parent.
 */
export function organizeTools(tools: ToolRow[]): ToolSection[] {
  const sections = new Map<string, MutableSection>();

  for (const tool of tools) {
    const segs = segmentsFor(tool);
    const sectionSeg = segs[0];
    let section = sections.get(sectionSeg);
    if (!section) {
      section = {
        key: `section:${sectionSeg}`,
        label: labelFor(sectionSeg),
        tools: [],
        groupMap: new Map(),
      };
      sections.set(sectionSeg, section);
    }
    // Section count covers every descendant (see `toolCount`).
    section.tools.push(tool);

    let map = section.groupMap;
    let prefix = section.key;
    let leaf: MutableGroup | null = null;
    for (const seg of segs.slice(1)) {
      prefix = `${prefix}/group:${seg}`;
      let group = map.get(seg);
      if (!group) {
        group = { key: prefix, label: labelFor(seg), tools: [], childMap: new Map() };
        map.set(seg, group);
      }
      leaf = group;
      map = group.childMap;
    }
    if (leaf) leaf.tools.push(tool);
  }

  const freezeGroups = (groups: Map<string, MutableGroup>): ToolGroup[] =>
    [...groups.values()]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((group) => ({
        key: group.key,
        label: group.label,
        tools: [...group.tools].sort(sortTools),
        children: freezeGroups(group.childMap),
      }));

  return [...sections.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((section) => ({
      key: section.key,
      label: section.label,
      tools: [...section.tools].sort(sortTools),
      groups: freezeGroups(section.groupMap),
    }));
}

export function expansionKeysForTool(tool: ToolRow): string[] {
  const segs = segmentsFor(tool);
  const keys: string[] = [`section:${segs[0]}`];
  let prefix = keys[0];
  for (const seg of segs.slice(1)) {
    prefix = `${prefix}/group:${seg}`;
    keys.push(prefix);
  }
  return keys;
}

/** Which tools the sidebar lists: every tool, or only the enabled or disabled ones. */
export type ToolFilter = 'all' | 'enabled' | 'disabled';

export const TOOL_FILTERS: ReadonlyArray<{ value: ToolFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'enabled', label: 'Enabled' },
  { value: 'disabled', label: 'Disabled' },
];

export function isToolFilter(value: unknown): value is ToolFilter {
  return TOOL_FILTERS.some((option) => option.value === value);
}

export function matchesToolFilter(tool: ToolRow, filter: ToolFilter): boolean {
  if (filter === 'enabled') return tool.enabled;
  if (filter === 'disabled') return !tool.enabled;
  return true;
}

/**
 * The count a category row shows for the tools it lists, and its tooltip.
 * Under a filter every listed tool matches, so the count is the number
 * listed. Under All it reads enabled/total when some are off, and just the
 * total when every one is on.
 */
export function toolCount(tools: ToolRow[], filter: ToolFilter): { text: string; title: string } {
  const total = tools.length;
  if (filter !== 'all') return { text: String(total), title: `${total} ${filter}` };
  const enabled = tools.filter((tool) => tool.enabled).length;
  return {
    text: enabled < total ? `${enabled}/${total}` : String(total),
    title: `${enabled} of ${total} enabled`,
  };
}
