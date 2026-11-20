import { useEffect, useMemo, useState, type FC } from 'react';
import { describeFlower, type CursorSpec, type EmotionId } from '@snaglet/shared/cursor';
import { useThemePalette } from './useThemePalette';

interface FlowerAvatarProps {
  spec: CursorSpec;
  emotion: EmotionId;
  size: number;
  animate?: boolean;
  crying?: boolean;
  celebrating?: boolean;
}

const SPLINES = '0.4 0 0.6 1;0.4 0 0.6 1';

/** Follows the OS reduced-motion preference. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(query.matches);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

/** The agent's generated flower-with-a-face, colored by the workspace theme. */
export const FlowerAvatar: FC<FlowerAvatarProps> = ({
  spec,
  emotion,
  size,
  animate = true,
  crying = false,
  celebrating = false,
}) => {
  const palette = useThemePalette();
  const reduced = usePrefersReducedMotion();
  const moving = animate && !reduced;
  const d = useMemo(
    () => describeFlower(spec, emotion, palette, { animate: moving, crying }),
    [spec, emotion, palette, moving, crying]
  );
  return (
    <svg
      viewBox={d.viewBox}
      width={size}
      height={size}
      role="img"
      aria-label={`flower avatar, ${emotion}`}
      style={{ overflow: 'visible', opacity: d.opacity }}
      data-animated={moving ? 'true' : 'false'}
    >
      <g>
        {moving && (
          <animateTransform
            attributeName="transform"
            type="translate"
            values={d.bounceVals}
            keyTimes="0;0.5;1"
            calcMode="spline"
            keySplines={SPLINES}
            dur={d.bounceDur}
            repeatCount="indefinite"
          />
        )}
        <g>
          {moving && (
            <animateTransform
              attributeName="transform"
              type="rotate"
              values={d.swayVals}
              keyTimes="0;0.5;1"
              calcMode="spline"
              keySplines={SPLINES}
              dur={d.swayDur}
              repeatCount="indefinite"
            />
          )}
          <g>
            {moving && (
              <animateTransform
                attributeName="transform"
                type="scale"
                values={d.pulseVals}
                keyTimes="0;0.5;1"
                calcMode="spline"
                keySplines={SPLINES}
                dur={d.pulseDur}
                repeatCount="indefinite"
              />
            )}
            {/* Petals breathe independently; the face stays readable and centered. */}
            <g data-petal-flutter={moving ? 'true' : 'false'}>
              {moving && (
                <animateTransform
                  attributeName="transform"
                  type="scale"
                  values={
                    emotion === 'happy' || emotion === 'proud'
                      ? '1 1;1.045 .98;1 1'
                      : '1 1;1.02 .99;1 1'
                  }
                  keyTimes="0;0.5;1"
                  calcMode="spline"
                  keySplines={SPLINES}
                  dur={emotion === 'sleepy' ? '5.5s' : '3.8s'}
                  repeatCount="indefinite"
                />
              )}
              {d.ring && (
                <path
                  d={d.ringD}
                  fill={d.colors.ringFill}
                  stroke={d.colors.ringStroke}
                  strokeWidth={d.strokeWidths.ring}
                  strokeLinejoin="round"
                />
              )}
              <path
                d={d.petalsD}
                fill={d.colors.petalFill}
                stroke={d.colors.petalStroke}
                strokeWidth={d.strokeWidths.petal}
                strokeLinejoin="round"
              />
            </g>
            <circle
              cx={0}
              cy={0}
              r={d.cr}
              fill={d.colors.centerFill}
              stroke={d.colors.centerStroke}
              strokeWidth={d.strokeWidths.center}
            />
            <circle
              cx={d.cheeks.lx}
              cy={d.cheeks.y}
              r={d.cheeks.r}
              fill={d.colors.cheek}
              opacity={d.cheeks.opacity}
            />
            <circle
              cx={d.cheeks.rx}
              cy={d.cheeks.y}
              r={d.cheeks.r}
              fill={d.colors.cheek}
              opacity={d.cheeks.opacity}
            />
            {d.browsD && (
              <path
                d={d.browsD}
                fill="none"
                stroke={d.colors.feature}
                strokeWidth={d.strokeWidths.face}
                strokeLinecap="round"
              />
            )}
            <g transform={`translate(0 ${d.eyeY})`}>
              <g>
                {moving && (
                  <animateTransform
                    attributeName="transform"
                    type="scale"
                    values={d.blinkVals}
                    keyTimes="0;0.9;0.95;1"
                    dur={d.blinkDur}
                    repeatCount="indefinite"
                  />
                )}
                <g data-eye-roll={moving && d.rollVals ? 'true' : undefined}>
                  {moving && d.rollVals && (
                    <animateTransform
                      attributeName="transform"
                      type="translate"
                      values={d.rollVals}
                      keyTimes={d.rollKeyTimes}
                      dur={d.rollDur}
                      repeatCount="indefinite"
                    />
                  )}
                  {d.pupilD && <path d={d.pupilD} fill={d.colors.feature} />}
                  {d.glintD && <path d={d.glintD} fill={d.colors.glint} opacity={d.glintOpacity} />}
                </g>
                {d.arcD && (
                  <path
                    d={d.arcD}
                    fill="none"
                    stroke={d.colors.feature}
                    strokeWidth={d.strokeWidths.face}
                    strokeLinecap="round"
                  />
                )}
              </g>
            </g>
            {celebrating &&
              Array.from({ length: 12 }, (_, i) => {
                const angle = (i * Math.PI) / 6;
                const x = Math.cos(angle) * d.cr * 1.8;
                const y = Math.sin(angle) * d.cr * 1.8;
                return (
                  <g key={i} data-confetti="true" transform={`translate(${x} ${y})`}>
                    {moving && (
                      <animateTransform
                        attributeName="transform"
                        type="translate"
                        values={`0 0;${x} ${y};${x * 1.3} ${y + d.cr}`}
                        dur="1.6s"
                        repeatCount="1"
                      />
                    )}
                    <rect
                      x="-1"
                      y="-2"
                      width="2"
                      height="4"
                      rx=".4"
                      fill={['#f7adc9', '#b6d7ff', '#d3b5f8', '#ffe49c'][i % 4]}
                      transform={`rotate(${i * 31})`}
                    />
                  </g>
                );
              })}
            {crying &&
              [-1, 1].map((side) => {
                const x = side * d.cr * spec.shape.eyeSpacing;
                const y = d.eyeY + d.cr * spec.shape.eyeSize * 1.35;
                return (
                  <path
                    key={side}
                    data-tear="true"
                    d="M 0 -2 Q -4.5 3 0 6 Q 4.5 3 0 -2"
                    fill="#75caff"
                    stroke="#d8f2ff"
                    strokeWidth=".5"
                    transform={`translate(${x} ${y})`}
                  >
                    {moving && (
                      <animateTransform
                        attributeName="transform"
                        type="translate"
                        values={`${x} ${y};${x} ${y + d.cr * 0.9}`}
                        dur=".6s"
                        repeatCount="3"
                      />
                    )}
                  </path>
                );
              })}
            <path
              data-crying={crying ? 'true' : undefined}
              d={d.mouthD}
              fill={d.colors.mouthFill}
              stroke={d.colors.feature}
              strokeWidth={d.strokeWidths.face}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        </g>
        {d.badge.glyph && (
          <>
            <circle
              cx={d.badge.x}
              cy={d.badge.y}
              r={d.badge.r}
              fill={d.colors.badgeFill}
              stroke={d.colors.badgeStroke}
              strokeWidth={d.strokeWidths.badge}
            />
            <text
              x={d.badge.x}
              y={d.badge.y + 4.5}
              textAnchor="middle"
              fontWeight={800}
              fontSize={13}
              fill={d.colors.badgeText}
            >
              {d.badge.glyph}
            </text>
          </>
        )}
      </g>
    </svg>
  );
};
