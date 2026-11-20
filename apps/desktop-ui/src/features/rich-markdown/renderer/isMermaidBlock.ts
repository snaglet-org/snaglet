/** Recognize diagram fences without treating explicitly labeled code as a chart. */
export function isMermaidBlock(language: string | null | undefined, source: string): boolean {
  const label = language?.trim().toLowerCase() ?? '';
  if (label === 'mermaid') return true;
  if (label && label !== 'flowchart' && label !== 'graph') return false;
  // A standard flowchart declaration is unambiguous; a stray arrow in prose
  // or source code is not. Ignore Mermaid comment lines before the declaration.
  const firstLine = source
    .split(/\r?\n/)
    .find((line) => line.trim() && !line.trim().startsWith('%%'));
  return /^\s*(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\b/.test(firstLine ?? '');
}
