/**
 * PolyTrack 0.6.2 part/color/environment constants used by the codec.
 * Sourced from the game's own enums (webpack chunks 494 / 2498 / 7852 / 7781)
 * and the part catalog (chunk 2600).
 */

/** TrackPartType ids this mod places. The full game enum has 186 parts. */
export const PART = {
  Start: 5,
  Finish: 6,
  Plane: 25,
  Block: 29,
  Checkpoint: 52,
  HalfBlock: 53,
  QuarterBlock: 54,
} as const;

/** Parts whose serialized form carries a u16 checkpointOrder. */
export const CHECKPOINT_PART_IDS: readonly number[] = [52, 65, 75, 77];

/** Parts whose serialized form carries a u32 startOrder. */
export const START_PART_IDS: readonly number[] = [5, 91, 92, 93];

/** RotationAxis enum (chunk 7781). */
export const AXIS = {
  YPositive: 0,
  YNegative: 1,
  XPositive: 2,
  XNegative: 3,
  ZPositive: 4,
  ZNegative: 5,
} as const;

/** Environment enum (chunk 7852). */
export const ENVIRONMENT = { Summer: 0, Winter: 1, Desert: 2 } as const;

/** TrackPartColor enum (chunk 2498). */
export const COLOR = {
  Default: 0,
  Summer: 1,
  Winter: 2,
  Desert: 3,
  Custom0: 32,
  Custom1: 33,
  Custom2: 34,
  Custom3: 35,
  Custom4: 36,
  Custom5: 37,
  Custom6: 38,
  Custom7: 39,
  Custom8: 40,
} as const;

/** UI swatches: color id -> approximate BlockSurface hex (from chunk 2600). */
export const COLOR_SWATCHES: readonly { id: number; name: string; hex: string }[] = [
  { id: COLOR.Default, name: 'Default', hex: '#b8b8b8' },
  { id: COLOR.Custom0, name: 'Black', hex: '#131313' },
  { id: COLOR.Custom1, name: 'Red', hex: '#501b1b' },
  { id: COLOR.Custom2, name: 'Orange', hex: '#7f4d2b' },
  { id: COLOR.Custom3, name: 'Yellow', hex: '#93862d' },
  { id: COLOR.Custom4, name: 'Green', hex: '#2a5e30' },
  { id: COLOR.Custom5, name: 'Teal', hex: '#236363' },
  { id: COLOR.Custom6, name: 'Blue', hex: '#20244b' },
  { id: COLOR.Custom7, name: 'Purple', hex: '#592759' },
  { id: COLOR.Custom8, name: 'Brown', hex: '#302318' },
];

/**
 * One placed part, in the game's tile grid: a full Block spans 4×4 tiles in
 * x/z and 1 unit in y, so adjacent Blocks sit 4 tiles apart horizontally and
 * 1 apart vertically (matches the game's legacy-v2 importer, which multiplies
 * x/z by 4 and keeps y).
 */
export interface PlacedPart {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly partId: number;
  /** 0..3 quarter turns around the axis. */
  readonly rotation: number;
  /** RotationAxis 0..5; upright parts use YPositive(0). */
  readonly rotationAxis: number;
  /** TrackPartColor id (COLOR.*). */
  readonly color: number;
  readonly checkpointOrder?: number;
  readonly startOrder?: number;
}
