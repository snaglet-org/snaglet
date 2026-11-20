import type { FC } from 'react';
import {
  BLOSSOM_CENTER,
  blossomOutline,
  type CursorFlower,
} from '@snaglet/shared/constants/agentCursor';

interface FlowerIconProps {
  flower: CursorFlower;
  /** Petal fill color (e.g. the flower's resolved color). */
  color: string;
  /** Rendered width/height in px. */
  size?: number;
}

interface FlowerShape {
  petals: number;
  /** Petal ellipse radii (rx across, ry along the radius). */
  rx: number;
  ry: number;
  /** Distance of the petal center from the flower center. */
  offset: number;
  center: string;
  centerR: number;
  /** Demo-style petal outline (darkened petal color) and outlined yellow center. */
  blossom?: boolean;
}

/** One distinct silhouette per flower id, drawn in a 32x32 box. */
const SHAPES: Record<CursorFlower, FlowerShape> = {
  // Swift demo flower (56-unit box) scaled to 32: petal 11x14 at 11 out, center 10 wide.
  blossom: {
    petals: 6,
    rx: 3.14,
    ry: 4,
    offset: 6.29,
    center: BLOSSOM_CENTER.fill,
    centerR: 2.86,
    blossom: true,
  },
  daisy: { petals: 8, rx: 2.6, ry: 6.5, offset: 8, center: '#f6b81a', centerR: 3.6 },
  tulip: { petals: 5, rx: 5, ry: 7.5, offset: 7, center: '#7a2b45', centerR: 2.4 },
  sunflower: { petals: 8, rx: 3, ry: 6, offset: 8.5, center: '#6b4423', centerR: 5.2 },
  rose: { petals: 6, rx: 6, ry: 6, offset: 6, center: '#8f1f2c', centerR: 3.4 },
  lavender: { petals: 6, rx: 2, ry: 5, offset: 8, center: '#5b4a8a', centerR: 2.2 },
  'cherry-blossom': { petals: 5, rx: 5, ry: 6, offset: 7.5, center: '#d9547f', centerR: 2.4 },
  lotus: { petals: 8, rx: 3.2, ry: 8, offset: 7.5, center: '#f6d56a', centerR: 3 },
  poppy: { petals: 4, rx: 7, ry: 7, offset: 6.5, center: '#2a1a1a', centerR: 3.2 },
};

/** Small radial-petal SVG flower, tinted with `color`. */
export const FlowerIcon: FC<FlowerIconProps> = ({ flower, color, size = 20 }) => {
  const s = SHAPES[flower];
  const mono = color === 'currentColor';
  const edge = mono ? 'currentColor' : s.blossom ? blossomOutline(color) : 'rgba(0,0,0,0.28)';
  const centerEdge = mono ? 'currentColor' : s.blossom ? BLOSSOM_CENTER.outline : edge;
  const sw = s.blossom ? 0.6 : 0.8;
  const petals = Array.from({ length: s.petals }, (_, i) => (360 / s.petals) * i);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label={flower}
      data-flower={flower}
    >
      <g transform="translate(16 16)">
        {petals.map((angle) => (
          <ellipse
            key={angle}
            cx={0}
            cy={-s.offset}
            rx={s.rx}
            ry={s.ry}
            fill={color}
            stroke={edge}
            strokeWidth={sw}
            transform={`rotate(${angle})`}
          />
        ))}
        <circle
          r={s.centerR}
          fill={mono ? 'var(--background)' : s.center}
          stroke={centerEdge}
          strokeWidth={sw}
        />
      </g>
    </svg>
  );
};
