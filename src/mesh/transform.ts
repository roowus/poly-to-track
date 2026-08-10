/**
 * Mesh transform: rotate (XYZ Euler, degrees) → scale → translate.
 * Applied to a copy of the positions before voxelization, so the voxel grid
 * always sees the final orientation.
 */
import type { TriangleMesh } from './types';

export interface MeshTransform {
  /** Euler rotation in degrees, applied X then Y then Z. */
  rotate: [number, number, number];
  /** Per-axis scale (uniform scaling = same value three times). */
  scale: [number, number, number];
  /** Translation in grid cells, applied last. */
  translate: [number, number, number];
}

export const IDENTITY: MeshTransform = {
  rotate: [0, 0, 0],
  scale: [1, 1, 1],
  translate: [0, 0, 0],
};

export function applyTransform(mesh: TriangleMesh, t: MeshTransform): TriangleMesh {
  const [rx, ry, rz] = t.rotate.map((d) => (d * Math.PI) / 180) as [number, number, number];
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);

  const src = mesh.positions;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    let x = src[i]!, y = src[i + 1]!, z = src[i + 2]!;
    // rotate X
    let y1 = y * cx - z * sx, z1 = y * sx + z * cx;
    y = y1; z = z1;
    // rotate Y
    const x1 = x * cy + z * sy, z2 = -x * sy + z * cy;
    x = x1; z = z2;
    // rotate Z
    const x2 = x * cz - y * sz, y2 = x * sz + y * cz;
    x = x2; y = y2;
    out[i] = x * t.scale[0] + t.translate[0];
    out[i + 1] = y * t.scale[1] + t.translate[1];
    out[i + 2] = z * t.scale[2] + t.translate[2];
  }
  return { positions: out, triangleCount: mesh.triangleCount };
}
