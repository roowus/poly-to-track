/**
 * Overlap detection for a staged insert — the Schematica-style "this will
 * intersect what you already built" warning.
 *
 * TSPML's editor-internals research (docs/research/editor-api-scavenging.md,
 * the #87 groundwork) documented the read surface on the same Track class our
 * mixin captures: `getPartsAt(x, y, z)` answers per-tile occupancy and
 * `getPartsWithin(minX, minY, minZ, maxX, maxY, maxZ)` returns every part
 * whose rotated tile footprint intersects the box. Both return plain data
 * copies, so probing them can never disturb the track.
 *
 * Two phases keep the check cheap per move at any build size:
 *  1. ONE `getPartsWithin` over the staged bounds (padded by a Block
 *     footprint). Empty means no overlap — the common case while positioning
 *     in free space costs a single call.
 *  2. Only when candidates exist, staged parts near them are tested
 *     tile-by-tile with `getPartsAt`, counting exactly how many of OUR parts
 *     sit on an occupied tile.
 */
import type { PlacedPart } from '../codec/parts';

/** Every part this mod stages (Block/HalfBlock/QuarterBlock/slopes) occupies
 *  the full Block footprint: tile offsets [-2..1]² in x/z, one y unit. The
 *  footprint is symmetric under the game's quarter-turn tile rotation, so the
 *  staged rotation never changes it. */
export const FOOTPRINT_OFFSETS: readonly number[] = [-2, -1, 0, 1];

/** The read slice of the captured track this module uses. Both methods exist
 *  on the 0.6.2 Track class; older bundles (or test fakes) may lack them —
 *  the check then reports `supported: false` and the UI stays silent. */
export interface OccupancyTrack {
  getPartsAt?(x: number, y: number, z: number): readonly unknown[];
  getPartsWithin?(
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
  ): readonly unknown[];
}

export interface OverlapResult {
  /** Staged parts sitting on ≥1 already-occupied tile (0 when clear). */
  readonly overlapping: number;
  /** False when the captured track doesn't expose the read methods. */
  readonly supported: boolean;
  /** True when the exact pass hit its cap — `overlapping` is a lower bound. */
  readonly capped: boolean;
}

const CLEAR: OverlapResult = { overlapping: 0, supported: true, capped: false };
const UNSUPPORTED: OverlapResult = { overlapping: 0, supported: false, capped: false };

/** How far an existing part's tiles may reach from its origin. Standard parts
 *  span [-2..1], but scenery can be bigger — pad the phase-2 vicinity filter
 *  generously; a too-wide filter only tests a few extra parts. */
const CANDIDATE_PAD_XZ = 16;
const CANDIDATE_PAD_Y = 8;

/**
 * Count how many of the staged `parts` (session coordinates + the session
 * `offset`) overlap parts already on the track. `cap` bounds the exact pass
 * so a 100k-part build over a dense area can't stall the UI — the warning
 * fires long before the cap matters.
 */
export function countOverlaps(
  track: OccupancyTrack | null | undefined,
  parts: readonly PlacedPart[],
  offset: { readonly x: number; readonly y: number; readonly z: number },
  cap = 5000,
): OverlapResult {
  if (typeof track?.getPartsAt !== 'function' || typeof track.getPartsWithin !== 'function') {
    return UNSUPPORTED;
  }
  if (parts.length === 0) return CLEAR;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of parts) {
    const x = p.x + offset.x, y = p.y + offset.y, z = p.z + offset.z;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  // Phase 1: anything at all inside our padded bounds? ([-2..1] footprint —
  // pad the min side by 2, the max side by 1.)
  const candidates = track.getPartsWithin(
    minX - 2, minY, minZ - 2, maxX + 1, maxY, maxZ + 1,
  ) as readonly { x?: number; y?: number; z?: number }[];
  if (candidates.length === 0) return CLEAR;

  // Phase 2: exact tile test, but only for staged parts near a candidate.
  let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity;
  let cMaxX = -Infinity, cMaxY = -Infinity, cMaxZ = -Infinity;
  for (const c of candidates) {
    const x = c.x ?? 0, y = c.y ?? 0, z = c.z ?? 0;
    if (x < cMinX) cMinX = x; if (x > cMaxX) cMaxX = x;
    if (y < cMinY) cMinY = y; if (y > cMaxY) cMaxY = y;
    if (z < cMinZ) cMinZ = z; if (z > cMaxZ) cMaxZ = z;
  }
  cMinX -= CANDIDATE_PAD_XZ; cMaxX += CANDIDATE_PAD_XZ;
  cMinZ -= CANDIDATE_PAD_XZ; cMaxZ += CANDIDATE_PAD_XZ;
  cMinY -= CANDIDATE_PAD_Y; cMaxY += CANDIDATE_PAD_Y;

  let overlapping = 0;
  let tested = 0;
  let capped = false;
  for (const p of parts) {
    const x = p.x + offset.x, y = p.y + offset.y, z = p.z + offset.z;
    if (x < cMinX || x > cMaxX || y < cMinY || y > cMaxY || z < cMinZ || z > cMaxZ) continue;
    if (tested >= cap) { capped = true; break; }
    tested++;
    outer: for (const dx of FOOTPRINT_OFFSETS) {
      for (const dz of FOOTPRINT_OFFSETS) {
        if (track.getPartsAt(x + dx, y, z + dz).length > 0) {
          overlapping++;
          break outer;
        }
      }
    }
  }
  return { overlapping, supported: true, capped };
}
