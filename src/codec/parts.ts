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
  BlockSlopeUp: 85,
  BlockSlopeDown: 86,
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
 * Nearest game block color for an sRGB triple — used to map colored-model
 * voxels onto the game's fixed palette. That palette is 9 DARK hues + 2 grays
 * (one light, one black): hue is the only thing it can represent well. So
 * match HUE first — near-blacks and the truly gray (s < 0.05, where the
 * sample's hue is noise) pick their gray by VALUE alone; every tinted color,
 * however pale, picks the nearest chromatic hue with saturation/value as
 * tiebreaks only. A brightness-weighted metric here is the "whole build came
 * out white" bug: pale tints (skin, pastels, light texture areas) all score
 * nearest the single light swatch.
 */
export function nearestColorId(r: number, g: number, b: number): number {
  const [h, s, v] = rgbToHsv(r, g, b);
  if (s < 0.05 || v < 0.1) return v > 0.4 ? COLOR.Default : COLOR.Custom0;
  let best: number = COLOR.Default;
  let bestScore = Infinity;
  for (const sw of COLOR_SWATCHES) {
    const [sh0, ss, sv] = swatchHsv(sw.id);
    if (ss === 0) continue; // grays handled above
    const sh = SWATCH_MATCH_HUE.get(sw.id) ?? sh0;
    let dh = Math.abs(h - sh);
    if (dh > 0.5) dh = 1 - dh; // hue wraps
    // Hue dominates, scaled by input saturation (a barely-tinted input's hue
    // is noisy); saturation and value only separate near hue-ties.
    const score = 40 * dh * dh * (0.2 + 0.8 * s) + 0.25 * (s - ss) ** 2 + 0.05 * (v - sv) ** 2;
    if (score < bestScore) { bestScore = score; best = sw.id; }
  }
  return best;
}

/** HSV of a palette swatch, computed once at module load. */
const SWATCH_HSV = new Map<number, [number, number, number]>(
  COLOR_SWATCHES.map((sw) => {
    const n = parseInt(sw.hex.slice(1), 16);
    return [sw.id, rgbToHsv((n >> 16) & 255, (n >> 8) & 255, n & 255)];
  }),
);
/**
 * Teal (hue 180°) and navy (243°) are 63° apart — the palette's biggest hue
 * gap. Matching navy at its literal hue makes everything down to hue 211 map
 * to teal (sky-blue azure included), which reads wrong: color-naming
 * conventions put the teal/blue boundary near 195°. Compress navy's MATCHING
 * hue to 0.575 (visually calibrated, like the slope rotations).
 */
const SWATCH_MATCH_HUE: ReadonlyMap<number, number> = new Map([[COLOR.Custom6, 0.575]]);
function swatchHsv(id: number): [number, number, number] {
  return SWATCH_HSV.get(id) ?? [0, 0, 0];
}

/** sRGB bytes → HSV, hue normalized to [0,1). */
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta + 6) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h /= 6;
  }
  return [h, max === 0 ? 0 : delta / max, max / 255];
}

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
