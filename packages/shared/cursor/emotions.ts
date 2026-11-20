export const EMOTION_IDS = [
  'neutral',
  'happy',
  'thinking',
  'focused',
  'curious',
  'surprised',
  'sleepy',
  'worried',
  'proud',
  'stumped',
  'angry',
  'embarrassed',
  'annoyed',
] as const;
export type EmotionId = (typeof EMOTION_IDS)[number];

export type EyeKind = 'open' | 'wide' | 'narrow' | 'arc' | 'line';
export type MouthKind =
  | 'smile'
  | 'grin'
  | 'flat'
  | 'o'
  | 'open'
  | 'small'
  | 'wavy'
  | 'slant'
  | 'frown';
export type BrowKind = '' | 'up' | 'flat' | 'worry' | 'stumped' | 'angry';

export interface EmotionDef {
  eyes: EyeKind;
  mouth: MouthKind;
  brows: BrowKind;
  cheeks: number;
  /** [amplitude in degrees, duration in seconds] */
  sway: [number, number];
  /** [height, duration in seconds] */
  bounce: [number, number];
  /** [scale amount, duration in seconds] */
  pulse: [number, number];
  opacity: number;
  badge: string;
  /** pupil offset, in units of 0.55 * eye radius */
  look?: [number, number];
  /** Constant head rotation in degrees; the sway wobbles around it. Default 0. */
  tilt?: number;
  /** Fast side-to-side shake: [horizontal travel in avatar units, seconds per cycle]. Still when motion is off. */
  shake?: [number, number];
  /** Cheek color override (a #hex): a red flush or a rosy blush instead of the flower's own cheek. */
  cheekColor?: string;
  /** Cheek size multiplier. Default 1. */
  cheekScale?: number;
  /** Pupils roll up and around, then settle; motion off holds them looking up and aside (see `look`). */
  eyeRoll?: boolean;
}

export const EMOTIONS: Record<EmotionId, EmotionDef> = {
  neutral: {
    eyes: 'open',
    mouth: 'smile',
    brows: '',
    cheeks: 0.35,
    sway: [2.5, 5],
    bounce: [0, 3],
    pulse: [0.02, 4],
    opacity: 1,
    badge: '',
  },
  happy: {
    eyes: 'arc',
    mouth: 'grin',
    brows: '',
    cheeks: 0.6,
    sway: [4, 2.4],
    bounce: [3, 1.2],
    pulse: [0.05, 1.2],
    opacity: 1,
    badge: '',
  },
  thinking: {
    eyes: 'open',
    mouth: 'flat',
    brows: 'up',
    cheeks: 0.2,
    sway: [5, 3.5],
    bounce: [0, 3],
    pulse: [0, 4],
    opacity: 1,
    badge: '…',
    look: [0.7, -0.7],
  },
  focused: {
    eyes: 'narrow',
    mouth: 'flat',
    brows: 'flat',
    cheeks: 0.15,
    sway: [1, 6],
    bounce: [0, 3],
    pulse: [0.03, 2],
    opacity: 1,
    badge: '',
  },
  curious: {
    eyes: 'wide',
    mouth: 'o',
    brows: 'up',
    cheeks: 0.35,
    sway: [6, 2.6],
    bounce: [2, 2],
    pulse: [0.02, 2.6],
    opacity: 1,
    badge: '?',
    look: [0.4, 0],
  },
  surprised: {
    eyes: 'wide',
    mouth: 'open',
    brows: 'up',
    cheeks: 0.3,
    sway: [1, 3],
    bounce: [5, 0.9],
    pulse: [0.08, 0.9],
    opacity: 1,
    badge: '!',
  },
  sleepy: {
    eyes: 'line',
    mouth: 'small',
    brows: '',
    cheeks: 0.25,
    sway: [2, 6],
    bounce: [0, 4],
    pulse: [0.05, 5],
    opacity: 0.72,
    badge: 'z',
  },
  worried: {
    eyes: 'open',
    mouth: 'wavy',
    brows: 'worry',
    cheeks: 0.1,
    sway: [3, 0.5],
    bounce: [0, 3],
    pulse: [0, 4],
    opacity: 1,
    badge: '',
  },
  proud: {
    eyes: 'arc',
    mouth: 'grin',
    brows: '',
    cheeks: 0.7,
    sway: [5, 2],
    bounce: [6, 1.1],
    pulse: [0.06, 1.1],
    opacity: 1,
    badge: '*',
  },
  stumped: {
    eyes: 'open',
    mouth: 'slant',
    brows: 'stumped',
    cheeks: 0.15,
    sway: [5, 3],
    bounce: [0, 3],
    pulse: [0.01, 4],
    opacity: 1,
    badge: '?',
    look: [-0.7, -0.5],
    tilt: 9,
  },
  angry: {
    eyes: 'open',
    mouth: 'frown',
    brows: 'angry',
    cheeks: 0.55,
    sway: [3, 0.14],
    bounce: [0, 3],
    pulse: [0.02, 0.4],
    opacity: 1,
    badge: '',
    look: [0, 0.2],
    shake: [6, 0.12],
    cheekColor: '#ff7a8a',
    cheekScale: 1.2,
  },
  embarrassed: {
    eyes: 'wide',
    mouth: 'small',
    brows: '',
    cheeks: 0.95,
    sway: [3, 2.4],
    bounce: [0, 3],
    pulse: [0.03, 2.4],
    opacity: 1,
    badge: '',
    look: [-0.5, 0.45],
    cheekColor: '#ff9db8',
    cheekScale: 1.6,
  },
  annoyed: {
    eyes: 'open',
    mouth: 'flat',
    brows: 'flat',
    cheeks: 0.15,
    sway: [1.5, 4],
    bounce: [0, 3],
    pulse: [0, 4],
    opacity: 1,
    badge: '',
    look: [0.9, -0.9],
    eyeRoll: true,
  },
};

export function isEmotionId(value: unknown): value is EmotionId {
  return typeof value === 'string' && (EMOTION_IDS as readonly string[]).includes(value);
}

export const STATUS_IDS = [
  'idle',
  'reading',
  'typing',
  'waiting',
  'asking',
  'done',
  'error',
] as const;
export type StatusId = (typeof STATUS_IDS)[number];

export const STATUS_EMOTION: Record<StatusId, EmotionId> = {
  idle: 'sleepy',
  reading: 'focused',
  typing: 'happy',
  waiting: 'sleepy',
  asking: 'curious',
  done: 'proud',
  error: 'stumped',
};
