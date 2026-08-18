import type { DecodedImage } from './texture';

/**
 * Per-triangle texture references, kept alongside the soup so the VOXELIZER
 * can sample a texel per voxel (a big UV-mapped face must not collapse to
 * one flat color — the per-triangle `colors` below is only the centroid
 * fallback). UVs are in IMAGE space (v grows downward): OBJ flips v at parse
 * time, glTF is already top-down.
 */
export interface MeshTexturing {
  /** u,v per vertex — 6 floats per triangle, same order as `positions`. */
  readonly uvs: Float32Array;
  /** Per-triangle index into `textures`; −1 = untextured triangle. */
  readonly triTexture: Int32Array;
  readonly textures: readonly DecodedImage[];
  /** Optional per-triangle LINEAR RGB multiplier (glTF baseColorFactor),
   *  3 floats per triangle; absent = 1,1,1. */
  readonly tints?: Float32Array;
}

/** Triangle soup: 9 floats per triangle (3 vertices × xyz). */
export interface TriangleMesh {
  readonly positions: Float32Array;
  readonly triangleCount: number;
  /** Optional per-TRIANGLE color, 3 bytes (RGB 0-255) per triangle. Present
   *  only when the source file carried color (OBJ vertex colors / MTL
   *  materials, colored binary STL). For textured triangles this is the UV-
   *  centroid sample — a fallback; per-voxel detail comes from `texturing`. */
  readonly colors?: Uint8Array;
  /** Optional texture channel — lets the voxelizer sample per VOXEL. */
  readonly texturing?: MeshTexturing;
}

export interface Bounds {
  readonly min: [number, number, number];
  readonly max: [number, number, number];
}

export function meshBounds(mesh: TriangleMesh): Bounds {
  const p = mesh.positions;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = p[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  return { min, max };
}
