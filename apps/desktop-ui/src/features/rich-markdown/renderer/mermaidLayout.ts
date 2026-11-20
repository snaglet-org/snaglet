/**
 * Flowchart layout numbers Snaglet pins in Mermaid's config (mermaidRender) and
 * sizes node chips by (mermaidChips), in the diagram's natural pixels.
 */

/** Mermaid's own flowchart label wrap. */
export const LABEL_WRAP = 120;

/**
 * A chart with node chips wraps labels later, so a chip's placeholder (see
 * mermaidChips) stays on one line for a title of about 25 characters.
 */
export const CHIP_LABEL_WRAP = 240;

/**
 * The least width Mermaid lays a flowchart label out at: a node is drawn
 * around at least this much, however short its text.
 */
export const MIN_NODE_WIDTH = 120;

/** A box in the image's natural pixels. */
export interface MermaidBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
