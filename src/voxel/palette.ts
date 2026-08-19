/**
 * Palette quantization for colored builds.
 *
 * Per-voxel texture sampling produces many near-duplicate colors, and baked
 * lighting (sunlit slopes, warm highlights) shifts texel HUES — so mapping
 * each voxel independently onto the game's saturated swatches turns lighting
 * into scattered yellow/red blocks ("paintball splotches") and breaks up
 * what should read as two or three materials.
 *
 * Quantize in PALETTE-ID space, not RGB: vote each voxel for its
 * nearestColorId, then iteratively drop the least-covering palette entry and
 * move its voxels to their nearest SURVIVING entry until every survivor
 * clears a coverage floor. Materials are what the model spends its area on;
 * a shade covering 4% of voxels is lighting, not a material. Repaint every
 * voxel with its surviving entry's exact swatch color — preview, ghost and
 * placed parts all agree, and the build uses only in-palette colors.
 */
import { COLOR, COLOR_SWATCHES, nearestColorId } from '../codec/parts';
import type { VoxelGrid } from './voxelize';

/**
 * Palette survival rules, calibrated for "reads as a few materials":
 *  1. keep at most MAX_SURVIVING_ENTRIES top coverage masses;
 *  2. drop anything under MIN_COVERAGE absolute (stray splotches);
 *  3. drop anything dwarfed by a CLOSE hue-neighbor (hue gap ≤
 *     LIGHTING_HUE_GAP and under NEIGHBOR_RATIO of that neighbor's votes).
 *     Baked lighting lands one palette step from the material it lights
 *     (sunlit grass → yellow, next to green); a far-hue accent (blue body,
 *     yellow trim) is not lighting and survives. This is the "mountain goes
 *     yellow/red" killer.
 */
export const MAX_SURVIVING_ENTRIES = 4;
export const MIN_COVERAGE = 0.05;
export const NEIGHBOR_RATIO = 0.45;
export const LIGHTING_HUE_GAP = 0.2; // 72° of hue — adjacent palette steps

/** User-tunable subset of the survival rules (the panel exposes these). */
export interface QuantizeOptions {
  /** Max distinct material colors (top coverage masses). */
  readonly maxColors?: number;
  /** Shade-merge strength 0–1: a hue-neighbor's entry dies when it covers
   *  less than this fraction of that neighbor. Higher = more merging. */
  readonly shadeMerge?: number;
  /** Minimum share of voxels an entry needs to survive (0–0.2). */
  readonly minCoverage?: number;
}
export const DEFAULT_QUANTIZE: Required<QuantizeOptions> = {
  maxColors: MAX_SURVIVING_ENTRIES,
  shadeMerge: NEIGHBOR_RATIO,
  minCoverage: MIN_COVERAGE,
};

/** Swatch id → exact sRGB bytes (for repainting survivors). */
const SWATCH_RGB = new Map<number, [number, number, number]>(
  COLOR_SWATCHES.map((sw) => {
    const n = parseInt(sw.hex.slice(1), 16);
    return [sw.id, [(n >> 16) & 255, (n >> 8) & 255, n & 255]];
  }),
);

/**
 * Quantize a grid's color channel in place: keep only the model's dominant
 * palette entries, repaint every colored voxel with its entry's exact swatch
 * color. Returns the colors array (same buffer, rewritten), or null when the
 * grid carries no colors.
 */
export function quantizeGridColors(grid: VoxelGrid, opts: QuantizeOptions = {}): Uint8Array | null {
  const maxColors = Math.max(1, Math.round(opts.maxColors ?? DEFAULT_QUANTIZE.maxColors));
  const shadeMerge = Math.min(1, Math.max(0, opts.shadeMerge ?? DEFAULT_QUANTIZE.shadeMerge));
  const minCoverage = Math.min(0.2, Math.max(0, opts.minCoverage ?? DEFAULT_QUANTIZE.minCoverage));
  const colors = grid.colors;
  if (!colors) return null;
  const cells = grid.cells;
  if (!cells) return colors;

  // One palette id per colored voxel.
  const ids = new Int16Array(cells.length).fill(-1);
  const votes = new Map<number, number>(); // palette id → voxel count
  let total = 0;
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i]) continue;
    const ci = i * 3;
    const r = colors[ci]!, g = colors[ci + 1]!, b = colors[ci + 2]!;
    if (r === 0 && g === 0 && b === 0) continue; // uncolored sentinel
    const id = nearestColorId(r, g, b);
    ids[i] = id;
    votes.set(id, (votes.get(id) ?? 0) + 1);
    total++;
  }
  if (total === 0 || votes.size <= 1) return colors;

  // PALE/DARK SPLITS inside one entry. Skin (~hue 20°) and brown clothes
  // (~hue 26°) vote for the SAME dark swatch — the hue palette can't tell
  // them apart, so the whole character used to repaint as one brown. But
  // their VALUES differ hugely. When one entry's votes are bimodal in value
  // (a light cluster and a dark cluster, both substantial), split it: the
  // DARK cluster keeps the swatch color, the LIGHT cluster becomes the light
  // gray swatch — skin reads as skin-light against brown clothes instead of
  // everything collapsing into "brown".
  for (const [id] of votes) {
    if (id === COLOR.Default || id === COLOR.Custom0) continue; // grays are value-true already
    const lightDark = { light: 0, dark: 0 };
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] !== id) continue;
      const ci = i * 3;
      const max = Math.max(colors[ci]!, colors[ci + 1]!, colors[ci + 2]!);
      if (max > 180) lightDark.light++;
      else lightDark.dark++;
    }
    const n = lightDark.light + lightDark.dark;
    if (lightDark.light / n >= 0.15 && lightDark.dark / n >= 0.15) {
      for (let i = 0; i < ids.length; i++) {
        if (ids[i] !== id) continue;
        const ci = i * 3;
        const max = Math.max(colors[ci]!, colors[ci + 1]!, colors[ci + 2]!);
        if (max > 180) ids[i] = COLOR.Default; // light cluster → light gray
      }
      votes.set(COLOR.Default, (votes.get(COLOR.Default) ?? 0) + lightDark.light);
      votes.set(id, (votes.get(id) ?? 0) - lightDark.light);
    }
  }

  // Keep the top coverage masses: rank entries by votes, keep the first
  // MAX_SURVIVING_ENTRIES, and also drop any entry under MIN_COVERAGE (a
  // 5%-rank entry is noise even when few entries compete). Dropped voxels
  // re-vote among survivors; repeat, because a re-vote can push a survivor
  // under the floor.
  let survivors = new Map(votes);
  for (let round = 0; round < 16; round++) {
    const byHue = [...survivors.keys()].sort((a, b) => swatchHue(a) - swatchHue(b));
    const isDwarfed = (id: number): boolean => {
      const k = byHue.indexOf(id);
      const hue = swatchHue(id);
      let worst = Infinity; // hue distance to the strongest close neighbor
      let neighbor = 0;
      for (let j = 0; j < byHue.length; j++) {
        if (j === k) continue;
        const other = byHue[j]!;
        let dh = Math.abs(hue - swatchHue(other));
        if (dh > 0.5) dh = 1 - dh;
        if (dh > LIGHTING_HUE_GAP) continue; // far in hue — not its lighting
        const cnt = survivors.get(other)!;
        if (cnt > neighbor || (cnt === neighbor && dh < worst)) { neighbor = cnt; worst = dh; }
      }
      return neighbor > 0 && survivors.get(id)! < shadeMerge * neighbor;
    };
    const ranked = [...survivors.entries()].sort((a, b) => b[1] - a[1]);
    const drop = ranked.find(([id, cnt], idx) =>
      idx >= maxColors || cnt / total < minCoverage || isDwarfed(id))
      ?? null;
    if (drop === null || survivors.size <= 1) break;
    survivors.delete(drop[0]);
    const among = new Set(survivors.keys());
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] !== drop[0]) continue;
      const ci = i * 3;
      ids[i] = nearestColorId(colors[ci]!, colors[ci + 1]!, colors[ci + 2]!, among);
      survivors.set(ids[i]!, (survivors.get(ids[i]!) ?? 0) + 1);
    }
  }

  // Repaint every colored voxel with its surviving entry's exact swatch.
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    if (id < 0) continue;
    const rgb = SWATCH_RGB.get(id);
    if (!rgb) continue;
    const ci = i * 3;
    colors[ci] = rgb[0];
    colors[ci + 1] = rgb[1];
    colors[ci + 2] = rgb[2];
  }
  return colors;
}



/** Literal hue of a palette swatch, for hue-circle adjacency. Grays sit at
 *  hue 0 (arbitrary but stable — they neighbor reds/purples). */
function swatchHue(id: number): number {
  const rgb = SWATCH_RGB.get(id);
  if (!rgb) return 0;
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  let h = 0;
  if (max === r) h = ((g - b) / delta + 6) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  return h / 6;
}
