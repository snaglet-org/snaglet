import type { DragEvent } from 'react';

/** Marks a rendered diagram image, so a drop carrying it is recognized and refused. */
export const MERMAID_PREVIEW_IMAGE = { 'data-snaglet-mermaid-preview': '' } as const;

/**
 * Native image drags export the entire SVG data URI as text. Never let that
 * presentation payload enter an editor (or its source).
 */
export function preventPreviewDrag(event: DragEvent) {
  event.preventDefault();
  event.stopPropagation();
}

/** Snaglet diagram previews are presentation, never editable image content. */
function isMermaidPreviewImageUrl(value: string): boolean {
  if (!/^data:image\/svg\+xml(?:;[^,]*)?,/i.test(value)) return false;
  // The renderer puts its own id on the SVG root. Inspect only the header;
  // a large generated SVG must not be decoded or parsed to reject a drop.
  const header = value.slice(0, 4096);
  return /(?:\bid|%20id)(?:=|%3d)(?:"|'|%22|%27)snaglet-mermaid-\d+(?:"|'|%22|%27)/i.test(header);
}

export function isMermaidPreviewDrop(data: Pick<DataTransfer, 'getData'>): boolean {
  for (const type of ['text/plain', 'text/uri-list']) {
    const value = data.getData(type).trim();
    if (isMermaidPreviewImageUrl(value)) return true;
  }
  const html = data.getData('text/html');
  if (!html) return false;
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(parsed.querySelectorAll('img')).some(
    (image) =>
      image.hasAttribute('data-snaglet-mermaid-preview') ||
      isMermaidPreviewImageUrl(image.getAttribute('src') ?? '')
  );
}
