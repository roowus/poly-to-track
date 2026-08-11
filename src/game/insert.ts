/**
 * Staged insertion session — Schematica-style. While the user positions the
 * model NOTHING is written to the track: the session just accumulates a tile
 * offset / quarter-turns over the built part list (the ghost mesh in ghost.ts
 * is the visual). `commit()` does the one real placement (with rollback);
 * `remove()` never touches the track at all.
 *
 * This is what makes transform mode O(1) per step — the old design re-placed
 * every part through `setPart` on each move, which froze the game for seconds
 * at high part counts.
 */
import type { PlacedPart } from '../codec/parts';
import type { GameTrack } from './track';

/** Quarter-turn a part origin about Y. Derived from the game's tile-rotation
 *  formula (chunk 5494: tile [x,z] → [z,−x−1]): applying it to a full 4×4
 *  footprint [−2..1]² shows the ORIGIN maps as (x,z) → (z,−x) with the part's
 *  own rotation bumped by 1 — the −1 is absorbed by the footprint's asymmetry. */
export function rotatePartY(p: PlacedPart): PlacedPart {
  // `|| 0` normalizes -0 (x=0 negated) — the codec serializes coordinates.
  return { ...p, x: p.z, z: -p.x || 0, rotation: (p.rotation + 1) % 4 };
}

/** Rotate a whole part list a quarter turn about Y, keeping its min corner
 *  fixed so the model doesn't orbit away from where the user put it. */
export function rotatePartsY(parts: readonly PlacedPart[]): PlacedPart[] {
  if (parts.length === 0) return [];
  const rotated = parts.map(rotatePartY);
  let minX0 = Infinity, minZ0 = Infinity, minX1 = Infinity, minZ1 = Infinity;
  for (const p of parts) { minX0 = Math.min(minX0, p.x); minZ0 = Math.min(minZ0, p.z); }
  for (const p of rotated) { minX1 = Math.min(minX1, p.x); minZ1 = Math.min(minZ1, p.z); }
  const dx = minX0 - minX1;
  const dz = minZ0 - minZ1;
  return rotated.map((p) => ({ ...p, x: p.x + dx, z: p.z + dz }));
}

/** Translate a part list. dx/dz are TILES (a Block cell is 4), dy is y units. */
export function translateParts(
  parts: readonly PlacedPart[], dx: number, dy: number, dz: number,
): PlacedPart[] {
  return parts.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy, z: p.z + dz }));
}

export interface InsertSession {
  /** Number of parts staged. */
  readonly count: number;
  /** The staged parts BEFORE the session offset (rotation already applied). */
  readonly parts: readonly PlacedPart[];
  /** Accumulated translation in tiles/y-units. */
  readonly offset: { readonly x: number; readonly y: number; readonly z: number };
  /** Tile-space bounds of the parts INCLUDING the offset, or null when empty. */
  readonly bounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  } | null;
  /** Move by tiles/units. Refuses (returns false) if it would sink below ground. */
  translate(dx: number, dy: number, dz: number): boolean;
  /** Quarter-turn about Y (regenerates the staged list — listeners should
   *  re-read `parts`). */
  rotateY(): void;
  /** Swap the staged parts for a re-built list (scale / resolution change),
   *  keeping the current session offset. */
  replaceParts(next: readonly PlacedPart[]): void;
  /** PLACE the parts into the track (the one real write; rolls back if the
   *  game refuses mid-way). Throws on failure — the session stays alive so
   *  the user can move the model and retry. */
  commit(): void;
  /** Drop the staged model. Never touches the track. */
  remove(): void;
  readonly alive: boolean;
}

/** Stage `parts` for insertion into `track`. Nothing is placed until commit. */
export function stageParts(track: GameTrack, parts: readonly PlacedPart[]): InsertSession {
  let staged: PlacedPart[] = [...parts];
  let alive = true;
  const offset = { x: 0, y: 0, z: 0 };

  return {
    get count() { return staged.length; },
    get parts() { return staged; },
    get alive() { return alive; },
    offset,
    get bounds() {
      if (!alive || staged.length === 0) return null;
      const min: [number, number, number] = [Infinity, Infinity, Infinity];
      const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (const p of staged) {
        if (p.x < min[0]) min[0] = p.x; if (p.x > max[0]) max[0] = p.x;
        if (p.y < min[1]) min[1] = p.y; if (p.y > max[1]) max[1] = p.y;
        if (p.z < min[2]) min[2] = p.z; if (p.z > max[2]) max[2] = p.z;
      }
      return {
        min: [min[0] + offset.x, min[1] + offset.y, min[2] + offset.z] as const,
        max: [max[0] + offset.x, max[1] + offset.y, max[2] + offset.z] as const,
      };
    },

    translate(dx, dy, dz) {
      if (!alive || staged.length === 0) return false;
      // The game throws "Track part below ground" for y<0 — refuse up front.
      let minY = Infinity;
      for (const p of staged) if (p.y < minY) minY = p.y;
      if (minY + offset.y + dy < 0) return false;
      offset.x += dx; offset.y += dy; offset.z += dz;
      return true;
    },

    rotateY() {
      if (!alive || staged.length === 0) return;
      staged = rotatePartsY(staged);
    },

    replaceParts(next) {
      if (!alive) return;
      staged = [...next];
    },

    commit() {
      if (!alive) throw new Error('session is over');
      const final = translateParts(staged, offset.x, offset.y, offset.z);
      const done: PlacedPart[] = [];
      try {
        for (const p of final) {
          track.setPart(p.x, p.y, p.z, p.partId, p.rotation, p.rotationAxis, p.color, null, null);
          done.push(p);
        }
      } catch (err) {
        // Roll back the partial placement so a failed apply never leaves half
        // a model behind. The session stays alive — move it and retry.
        for (const p of done) {
          try { track.deleteSpecificPart(p.partId, p.x, p.y, p.z, p.rotation, p.rotationAxis); } catch { /* already gone */ }
        }
        track.refreshMeshes();
        throw err;
      }
      track.refreshMeshes();
      alive = false;
      staged = [];
    },

    remove() {
      alive = false;
      staged = [];
    },
  };
}
